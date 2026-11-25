import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  SECRET_REQUEST_DEFAULT_PLACEHOLDER,
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  type SecretRequestItem,
  type SecretRequestReply,
  vaultApprovalPrompt,
  vaultRequestDisplay,
  type VaultRequestDisplay,
} from "@t3tools/client-runtime/secret-request";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  VAULT_KIND_LABELS,
  vaultDraftForRequest,
  vaultEntryDetails,
  vaultNamePlaceholder,
  vaultSaveFromRequest,
  vaultSaveFromRequestIssue,
  vaultScopeLabel,
  type VaultDraft,
} from "@t3tools/client-runtime/vault";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ProjectId,
  VaultEntryKind,
  VaultMatchesForRequestResult,
  VaultRequestMatch,
} from "@t3tools/contracts";
import { CheckIcon, KeyRoundIcon, LockIcon, MinusIcon, ShieldCheckIcon } from "lucide-react";
import { useAtomValue } from "@effect/atom-react";
import { useEffect, useEffectEvent, useId, useRef, useState, type FormEvent } from "react";

import { useProjects, useThreadShell } from "../../state/entities";
import { serverEnvironment } from "../../state/server";
import { isSharedEnvironmentAtom } from "../../state/sharing";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { useColleagueName } from "../sharing/colleagues";
import { WorkLogRow } from "./WorkLog";

const KINDS: ReadonlyArray<VaultEntryKind> = ["password", "token", "note"];

// Timeline rows remount as they scroll; a card asks for its matches once.
const matchesByCard = new Map<string, VaultMatchesForRequestResult>();

function useVaultMatches(environmentId: EnvironmentId, item: SecretRequestItem) {
  const key = JSON.stringify([environmentId, item.threadId, item.id]);
  const allowed = useAtomValue(
    serverEnvironment.vaultMatchesForRequest.permissionAtom(environmentId),
  );
  const fetchMatches = useAtomCommand(serverEnvironment.vaultMatchesForRequest, {
    reportFailure: false,
  });
  const [matches, setMatches] = useState(() => matchesByCard.get(key) ?? null);
  const store = useEffectEvent((result: Awaited<ReturnType<typeof fetchMatches>>) => {
    if (result._tag !== "Success") return;
    matchesByCard.set(key, result.value);
    setMatches(result.value);
  });
  // oxlint-disable-next-line t3code/react-effect-budget -- asks the environment for this card's vault matches once
  useEffect(() => {
    if (!allowed || matchesByCard.has(key)) return;
    void fetchMatches({
      environmentId,
      input: { threadId: item.threadId, turnItemId: item.id },
    }).then(store);
  }, [allowed, key, fetchMatches, environmentId, item.threadId, item.id]);
  return allowed ? matches : null;
}

export function SecretRequestCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const display = secretRequestDisplay(item, props.visibility);
  // Secrets are saved on the owner's machine, so only the owner answers.
  const sharedEnvironment = useAtomValue(isSharedEnvironmentAtom(props.environmentId));
  const vaultDisplay = vaultRequestDisplay(item, props.visibility);
  if (vaultDisplay !== null) {
    return vaultDisplay.kind === "approval-pending" ? (
      <VaultApprovalRequest
        environmentId={props.environmentId}
        item={item}
        display={vaultDisplay}
        sharedEnvironment={sharedEnvironment}
      />
    ) : (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={
          vaultDisplay.kind === "pending-elsewhere" ? (
            <LockIcon className="size-3.5 text-icon-muted" aria-hidden />
          ) : vaultDisplay.outcome === "used" ? (
            <KeyRoundIcon className="size-3.5 text-icon-muted" aria-hidden />
          ) : (
            <MinusIcon className="size-3.5 text-icon-muted" aria-hidden />
          )
        }
        label={vaultDisplay.label}
      />
    );
  }
  if (display.kind === "pending" && sharedEnvironment) {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<LockIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={<>{item.label} · Waiting for the owner</>}
      />
    );
  }
  if (display.kind === "answered" || display.kind === "pending-elsewhere") {
    const Icon =
      display.kind === "pending-elsewhere"
        ? LockIcon
        : display.outcome === "saved"
          ? CheckIcon
          : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {item.label} · {display.label}
          </>
        }
      />
    );
  }
  return <PendingSecretRequestForm environmentId={props.environmentId} item={item} />;
}

function VaultApprovalRequest(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
  readonly display: Extract<VaultRequestDisplay, { kind: "approval-pending" }>;
  readonly sharedEnvironment: boolean;
}) {
  const { item, display } = props;
  const permitted = useAtomValue(
    serverEnvironment.answerVaultApproval.permissionAtom(props.environmentId),
  );
  const answer = useAtomCommand(serverEnvironment.answerVaultApproval, {
    label: "answer vault approval",
  });
  const requesterName = useColleagueName(display.requestedByAccountId);
  const threadTitle = useThreadShell(scopeThreadRef(props.environmentId, item.threadId))?.title;
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (props.sharedEnvironment || !permitted) {
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<LockIcon className="size-3.5 text-icon-muted" aria-hidden />}
        label={<>Waiting for the owner to allow {display.entryName}</>}
      />
    );
  }
  const decide = async (decision: "allow" | "deny") => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const result = await answer({
      environmentId: props.environmentId,
      input: { threadId: item.threadId, turnItemId: item.id, decision },
    }).finally(() => setSubmitting(false));
    if (result._tag !== "Success" && !isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };
  return (
    <div
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <p className="text-sm font-medium text-foreground">
        {vaultApprovalPrompt({ requesterName, entryName: display.entryName, threadTitle })}
      </p>
      {error !== null ? (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void decide("deny")}
        >
          Deny
        </Button>
        <Button type="button" size="sm" disabled={submitting} onClick={() => void decide("allow")}>
          Allow once
        </Button>
      </div>
    </div>
  );
}

function PendingSecretRequestForm(props: {
  readonly environmentId: EnvironmentId;
  readonly item: SecretRequestItem;
}) {
  const { item } = props;
  const inputId = useId();
  const errorId = useId();
  const privacyId = useId();
  const answer = useAtomCommand(serverEnvironment.answerSecretRequest, {
    label: "answer secret request",
    // The failure cause holds the request; keep it out of the console.
    reportFailure: false,
    reportDefect: false,
  });
  const vault = useVaultMatches(props.environmentId, item);
  const projectId =
    useThreadShell(scopeThreadRef(props.environmentId, item.threadId))?.projectId ?? null;
  const projects = useProjects();
  const projectTitle = (id: ProjectId) =>
    projects.find((project) => project.environmentId === props.environmentId && project.id === id)
      ?.title;
  const [secret, setSecret] = useState("");
  const [saveDraft, setSaveDraft] = useState<VaultDraft | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Enter and click can both submit before a render.
  const inFlight = useRef(false);
  const saveIssue = saveDraft === null ? null : vaultSaveFromRequestIssue(saveDraft);

  const send = async (reply: SecretRequestReply) => {
    const input = secretRequestAnswerInput(item, reply);
    if (input === null || inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const result = await answer({ environmentId: props.environmentId, input }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") {
      setSecret("");
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(secretRequestFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (saveIssue !== null) return;
    void send({
      type: "save",
      secret,
      saveToVault: saveDraft === null ? undefined : vaultSaveFromRequest(saveDraft),
    });
  };
  const editSave = (patch: Partial<VaultDraft>) => {
    setSaveDraft((current) => (current === null ? current : { ...current, ...patch }));
    setError(null);
  };

  const matches = vault?.matches ?? [];
  return (
    <form
      data-v2-item-type={item.type}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
      onSubmit={onSubmit}
      autoComplete="off"
      onPointerDown={(event) => {
        if (!(event.target instanceof HTMLElement)) return;
        if (event.target.closest("input, button, a, label, [data-vault-match]")) return;
        document.getElementById(inputId)?.focus();
      }}
    >
      <div className="flex min-w-0 flex-col gap-1">
        <label htmlFor={inputId} className="text-sm font-medium text-foreground">
          {item.label}
        </label>
        {item.reason.trim() ? <p className="text-sm text-muted-foreground">{item.reason}</p> : null}
      </div>
      {matches.length > 0 ? (
        <ul aria-label="Matching vault entries" className="flex min-w-0 flex-col gap-1.5">
          {matches.map((match) => (
            <VaultMatchRow
              key={match.entry.id}
              match={match}
              disabled={submitting}
              projectTitle={projectTitle}
              currentProjectTitle={projectId === null ? undefined : projectTitle(projectId)}
              onUse={(alsoAllowProject) =>
                void send({ type: "vault", entryId: match.entry.id, alsoAllowProject })
              }
            />
          ))}
        </ul>
      ) : null}
      <div className="flex min-w-0 items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            id={inputId}
            // Password fields prompt to save credentials; this secret is not a login.
            type="text"
            className="[-webkit-text-security:disc]"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            data-1p-ignore
            data-lpignore="true"
            data-bwignore
            placeholder={item.placeholder ?? SECRET_REQUEST_DEFAULT_PLACEHOLDER}
            value={secret}
            disabled={submitting}
            aria-invalid={error !== null || undefined}
            aria-describedby={error !== null ? `${privacyId} ${errorId}` : privacyId}
            onChange={(event) => setSecret(event.currentTarget.value)}
          />
        </div>
        <Button
          type="submit"
          disabled={submitting || secret.trim().length === 0 || saveIssue !== null}
        >
          Save securely
        </Button>
      </div>
      {vault !== null && matches.length === 0 ? (
        <Label>
          <Checkbox
            checked={saveDraft !== null}
            disabled={submitting}
            onCheckedChange={(checked) => {
              setSaveDraft(checked ? vaultDraftForRequest(vault) : null);
              setError(null);
            }}
          />
          Save to vault
        </Label>
      ) : null}
      {saveDraft !== null ? (
        <fieldset disabled={submitting} className="flex min-w-0 flex-col gap-3">
          <ToggleGroup
            aria-label="Kind"
            value={[saveDraft.kind]}
            onValueChange={(values) => {
              const kind = KINDS.find((candidate) => candidate === values[0]);
              if (kind) editSave({ kind });
            }}
          >
            {KINDS.map((kind) => (
              <Toggle key={kind} value={kind}>
                {VAULT_KIND_LABELS[kind]}
              </Toggle>
            ))}
          </ToggleGroup>
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`${inputId}-name`}>Name</Label>
            <Input
              id={`${inputId}-name`}
              value={saveDraft.name}
              placeholder={vaultNamePlaceholder(saveDraft)}
              autoComplete="off"
              onChange={(event) => editSave({ name: event.currentTarget.value })}
            />
          </div>
          {saveDraft.kind === "token" ? null : (
            <div className="flex min-w-0 flex-col gap-1.5">
              <Label htmlFor={`${inputId}-username`}>Username</Label>
              <Input
                id={`${inputId}-username`}
                value={saveDraft.username}
                autoComplete="off"
                onChange={(event) => editSave({ username: event.currentTarget.value })}
              />
            </div>
          )}
          <div className="flex min-w-0 flex-col gap-1.5">
            <Label htmlFor={`${inputId}-domains`}>Domains</Label>
            <Input
              id={`${inputId}-domains`}
              value={saveDraft.domains}
              placeholder="example.com"
              autoComplete="off"
              onChange={(event) => editSave({ domains: event.currentTarget.value })}
            />
          </div>
          {projectId === null ? null : (
            <ToggleGroup
              aria-label="Available in"
              value={[saveDraft.scope === "global" ? "global" : "project"]}
              onValueChange={(values) => {
                if (values[0] === "global") editSave({ scope: "global" });
                else if (values[0] === "project") editSave({ scope: { projects: [projectId] } });
              }}
            >
              <Toggle value="global">All projects</Toggle>
              <Toggle value="project">{projectTitle(projectId) ?? "This project"}</Toggle>
            </ToggleGroup>
          )}
          {saveIssue?.kind === "invalid" ? (
            <p role="alert" className="text-xs text-destructive">
              {saveIssue.message}
            </p>
          ) : null}
        </fieldset>
      ) : null}
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex min-w-0 items-center justify-between gap-2">
        <p
          id={privacyId}
          className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
        >
          <ShieldCheckIcon className="size-3.5 shrink-0" aria-hidden />
          {secretRequestPrivacyNote(item)}
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost-muted"
          disabled={submitting}
          onClick={() => void send({ type: "decline" })}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

function VaultMatchRow(props: {
  readonly match: VaultRequestMatch;
  readonly disabled: boolean;
  readonly projectTitle: (projectId: ProjectId) => string | undefined;
  readonly currentProjectTitle: string | undefined;
  readonly onUse: (alsoAllowProject: boolean) => void;
}) {
  const { entry, inScope } = props.match;
  const details = vaultEntryDetails(entry);
  return (
    <li
      data-vault-match
      className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border/60 px-3 py-2"
    >
      <div className="flex min-w-0 flex-col">
        <span className="truncate text-sm text-foreground">{entry.name}</span>
        {details || !inScope ? (
          <span className="truncate text-xs text-muted-foreground">
            {[details, inScope ? "" : vaultScopeLabel(entry.scope, props.projectTitle)]
              .filter(Boolean)
              .join(" · ")}
          </span>
        ) : null}
      </div>
      <Button
        type="button"
        size="xs"
        variant="outline"
        disabled={props.disabled}
        onClick={() => props.onUse(!inScope)}
      >
        {inScope ? "Use" : `Also allow in ${props.currentProjectTitle ?? "this project"}`}
      </Button>
    </li>
  );
}
