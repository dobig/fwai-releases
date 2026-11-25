import { useAtomValue } from "@effect/atom-react";
import { isSharedEnvironmentEntry } from "@t3tools/client-runtime/connection";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EMPTY_VAULT_DRAFT,
  sortVaultEntries,
  toggleVaultScopeProject,
  VAULT_DELIVERY_LABELS,
  VAULT_KIND_LABELS,
  vaultCreateInput,
  vaultDraftFromEntry,
  vaultDraftIssue,
  vaultNamePlaceholder,
  vaultPreviousVersionLabel,
  vaultScopeLabel,
  vaultUpdateInput,
  type VaultDraft,
} from "@t3tools/client-runtime/vault";
import type {
  EnvironmentId,
  ProjectId,
  VaultEntryKind,
  VaultEntrySummary,
  VaultEntryUsage,
  VaultListResult,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { PlusIcon } from "lucide-react";
import { type ReactNode, useEffect, useEffectEvent, useState } from "react";

import { hasCloudPublicConfig } from "~/cloud/publicConfig";
import { requestConfirmDialog } from "~/confirmDialog";
import { useNowMinute } from "~/hooks/useNowMinute";
import { useProjects, useThreadShell } from "~/state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "~/state/environments";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Colleague } from "../sharing/colleagues";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import {
  Dialog,
  DialogClose,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";
import { SecretsSyncSection } from "./SecretsSyncSection";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

const KINDS: ReadonlyArray<VaultEntryKind> = ["password", "token", "note"];

export function SecretsSettingsPanel() {
  const { environments } = useEnvironments();
  const own = environments.filter((environment) => !isSharedEnvironmentEntry(environment.entry));
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId =
    selected ??
    own.find((environment) => environment.environmentId === primary)?.environmentId ??
    own[0]?.environmentId ??
    null;
  const environmentPicker =
    own.length > 1 ? (
      <Select
        value={environmentId ?? ""}
        onValueChange={(value) => {
          if (value !== null) setSelected(value as EnvironmentId);
        }}
      >
        <SelectTrigger aria-label="Environment" className="w-48" size="sm">
          <SelectValue>
            {own.find((environment) => environment.environmentId === environmentId)?.label}
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {own.map((environment) => (
            <SelectItem key={environment.environmentId} value={environment.environmentId}>
              {environment.label}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
    ) : null;

  return (
    <SettingsPageContainer>
      {environmentId === null ? (
        <SettingsSection {...searchableSetting("secrets")}>
          <SettingsRow title="Connect one of your environments to keep secrets in it" />
        </SettingsSection>
      ) : (
        <EnvironmentSecrets
          key={environmentId}
          environmentId={environmentId}
          environmentPicker={environmentPicker}
        />
      )}
    </SettingsPageContainer>
  );
}

type Editor = { readonly entry: VaultEntrySummary | null };

function EnvironmentSecrets({
  environmentId,
  environmentPicker,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentPicker: ReactNode;
}) {
  const list = useAtomCommand(serverEnvironment.listVault, { reportFailure: false });
  const remove = useAtomCommand(serverEnvironment.deleteVaultEntry, { reportFailure: false });
  const restore = useAtomCommand(serverEnvironment.restoreVaultPreviousVersion, {
    reportFailure: false,
  });
  const canRestore = useAtomValue(
    serverEnvironment.restoreVaultPreviousVersion.permissionAtom(environmentId),
  );
  const canCreate = useAtomValue(serverEnvironment.createVaultEntry.permissionAtom(environmentId));
  const canUpdate = useAtomValue(serverEnvironment.updateVaultEntry.permissionAtom(environmentId));
  const canDelete = useAtomValue(serverEnvironment.deleteVaultEntry.permissionAtom(environmentId));
  const [vault, setVault] = useState<VaultListResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);

  const apply = (result: Awaited<ReturnType<typeof list>>) => {
    if (result._tag === "Success") {
      setVault(result.value);
      setError(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not read the vault."));
    }
  };
  const reload = async () => apply(await list({ environmentId, input: undefined }));
  const applyOnOpen = useEffectEvent(apply);
  // oxlint-disable-next-line t3code/react-effect-budget -- reads the vault from the chosen environment when it is shown
  useEffect(() => {
    void list({ environmentId, input: undefined }).then(applyOnOpen);
  }, [list, environmentId]);

  const deleteEntry = async (entry: VaultEntrySummary) => {
    const prompt = `Delete ${entry.name}?\nAgents can no longer use it.`;
    const confirmed =
      (await requestConfirmDialog(prompt, { variant: "destructive" })) ?? window.confirm(prompt);
    if (!confirmed) return;
    const result = await remove({ environmentId, input: { id: entry.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not delete ${entry.name}`,
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
    }
    await reload();
  };

  const restorePrevious = async (entry: VaultEntrySummary) => {
    const result = await restore({ environmentId, input: { id: entry.id } });
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: `Could not restore ${entry.name}`,
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
    }
    await reload();
  };

  const entries = vault === null ? [] : sortVaultEntries(vault.entries);
  return (
    <>
      <SettingsSection
        {...searchableSetting("secrets")}
        titleAction={environmentPicker}
        headerAction={
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={!canCreate || vault === null}
            onClick={() => setEditor({ entry: null })}
          >
            <PlusIcon className="size-3" />
            Add
          </Button>
        }
      >
        {error !== null ? (
          <SettingsRow title="Could not read the vault" description={error} />
        ) : vault === null ? null : (
          <>
            {vault.unreadable > 0 ? (
              <SettingsRow
                title={
                  vault.unreadable === 1
                    ? "1 entry could not be read"
                    : `${vault.unreadable} entries could not be read`
                }
              />
            ) : null}
            {entries.length === 0 ? <SettingsRow title="No secrets yet" /> : null}
            {entries.map((entry) => (
              <SecretRow
                key={entry.id}
                environmentId={environmentId}
                entry={entry}
                onEdit={canUpdate ? () => setEditor({ entry }) : undefined}
                onDelete={canDelete ? () => void deleteEntry(entry) : undefined}
                onUsePrevious={canRestore ? () => void restorePrevious(entry) : undefined}
              />
            ))}
          </>
        )}
        {editor ? (
          <SecretEditorDialog
            environmentId={environmentId}
            entry={editor.entry}
            onClose={() => setEditor(null)}
            onSaved={() => {
              setEditor(null);
              void reload();
            }}
          />
        ) : null}
      </SettingsSection>
      {hasCloudPublicConfig() ? (
        <SecretsSyncSection environmentId={environmentId} onEntriesChanged={() => void reload()} />
      ) : null}
    </>
  );
}

function SecretRow({
  environmentId,
  entry,
  onEdit,
  onDelete,
  onUsePrevious,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: VaultEntrySummary;
  readonly onEdit: (() => void) | undefined;
  readonly onDelete: (() => void) | undefined;
  readonly onUsePrevious: (() => void) | undefined;
}) {
  const projectTitle = useProjectTitle(environmentId);
  const details = [
    entry.username,
    entry.domains.join(", ") || undefined,
    vaultScopeLabel(entry.scope, projectTitle),
  ].filter((part) => part !== undefined);
  return (
    <SettingsRow
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{entry.name}</span>
          <Badge variant="secondary" size="sm">
            {VAULT_KIND_LABELS[entry.kind]}
          </Badge>
          {entry.nameConflict ? (
            <Badge variant="warning" size="sm">
              Name used twice
            </Badge>
          ) : null}
        </span>
      }
      description={
        <span className="flex flex-col gap-0.5">
          <span>{details.join(" · ")}</span>
          {entry.lastUse ? (
            <LastUse environmentId={environmentId} usage={entry.lastUse} />
          ) : (
            <span>Never used</span>
          )}
          {entry.previous ? <PreviousVersion previous={entry.previous} /> : null}
        </span>
      }
      control={
        <span className="flex gap-1">
          {entry.previous && onUsePrevious ? (
            <Button size="xs" variant="ghost" onClick={onUsePrevious}>
              Use this version
            </Button>
          ) : null}
          {onEdit ? (
            <Button size="xs" variant="ghost" onClick={onEdit}>
              Edit
            </Button>
          ) : null}
          {onDelete ? (
            <Button size="xs" variant="ghost" onClick={onDelete}>
              Delete
            </Button>
          ) : null}
        </span>
      }
    />
  );
}

function LastUse({
  environmentId,
  usage,
}: {
  readonly environmentId: EnvironmentId;
  readonly usage: VaultEntryUsage;
}) {
  const nowMinute = useNowMinute();
  const thread = useThreadShell(scopeThreadRef(environmentId, usage.threadId));
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-x-1">
      <span>Used {formatRelativeTimeLabel(usage.at, Date.parse(`${nowMinute}:00.000Z`))} in</span>
      {thread ? (
        <Link
          to="/$environmentId/$threadId"
          params={{ environmentId, threadId: usage.threadId }}
          className="truncate underline underline-offset-2"
        >
          {thread.title}
        </Link>
      ) : (
        <span>a thread no longer here</span>
      )}
      {usage.accountId ? (
        <>
          <span>by</span>
          <Colleague userId={usage.accountId} />
        </>
      ) : null}
      <span>· {VAULT_DELIVERY_LABELS[usage.delivery]}</span>
    </span>
  );
}

function PreviousVersion({
  previous,
}: {
  readonly previous: NonNullable<VaultEntrySummary["previous"]>;
}) {
  const nowMinute = useNowMinute();
  return (
    <span>
      {vaultPreviousVersionLabel(
        previous,
        formatRelativeTimeLabel(previous.replacedAt, Date.parse(`${nowMinute}:00.000Z`)),
      )}
    </span>
  );
}

function useProjectTitle(environmentId: EnvironmentId) {
  const projects = useProjects();
  return (projectId: ProjectId) =>
    projects.find((project) => project.environmentId === environmentId && project.id === projectId)
      ?.title;
}

function SecretEditorDialog({
  environmentId,
  entry,
  onClose,
  onSaved,
}: {
  readonly environmentId: EnvironmentId;
  readonly entry: VaultEntrySummary | null;
  readonly onClose: () => void;
  readonly onSaved: () => void;
}) {
  const create = useAtomCommand(serverEnvironment.createVaultEntry, { reportFailure: false });
  const update = useAtomCommand(serverEnvironment.updateVaultEntry, { reportFailure: false });
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const [draft, setDraft] = useState<VaultDraft>(() =>
    entry === null ? EMPTY_VAULT_DRAFT : vaultDraftFromEntry(entry),
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const issue = vaultDraftIssue(draft, entry === null ? "create" : "edit");
  const changes = entry === null ? null : vaultUpdateInput(entry, draft);
  const canSave = issue === null && !saving && (entry === null || changes !== null);
  const edit = (patch: Partial<VaultDraft>) => {
    setDraft((current) => ({ ...current, ...patch }));
    setError(null);
  };

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    const result =
      entry === null
        ? await create({ environmentId, input: vaultCreateInput(draft) })
        : changes === null
          ? null
          : await update({ environmentId, input: changes });
    setSaving(false);
    if (result === null || result._tag === "Success") {
      onSaved();
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not save the secret."));
    }
  };

  const shownError = error ?? (issue?.kind === "invalid" ? issue.message : null);
  const valuePlaceholder = entry === null ? undefined : "Stored, type to replace";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !saving) onClose();
      }}
    >
      <DialogPopup className="max-w-lg">
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          <DialogHeader>
            <DialogTitle>{entry === null ? "Add secret" : `Edit ${entry.name}`}</DialogTitle>
          </DialogHeader>
          <DialogPanel>
            <fieldset disabled={saving} className="min-w-0 space-y-4">
              <ToggleGroup
                aria-label="Kind"
                value={[draft.kind]}
                onValueChange={(values) => {
                  const kind = KINDS.find((candidate) => candidate === values[0]);
                  if (kind) edit({ kind });
                }}
              >
                {KINDS.map((kind) => (
                  <Toggle key={kind} value={kind}>
                    {VAULT_KIND_LABELS[kind]}
                  </Toggle>
                ))}
              </ToggleGroup>
              <div className="space-y-1.5">
                <Label htmlFor="vault-entry-name">Name</Label>
                <Input
                  id="vault-entry-name"
                  value={draft.name}
                  placeholder={vaultNamePlaceholder(draft)}
                  autoComplete="off"
                  onChange={(event) => edit({ name: event.target.value })}
                />
              </div>
              {draft.kind === "token" ? null : (
                <div className="space-y-1.5">
                  <Label htmlFor="vault-entry-username">Username</Label>
                  <Input
                    id="vault-entry-username"
                    value={draft.username}
                    autoComplete="off"
                    onChange={(event) => edit({ username: event.target.value })}
                  />
                </div>
              )}
              <div className="space-y-1.5">
                <Label htmlFor="vault-entry-value">
                  {draft.kind === "password" ? "Password" : "Value"}
                </Label>
                {draft.kind === "note" ? (
                  <Textarea
                    id="vault-entry-value"
                    value={draft.value}
                    placeholder={valuePlaceholder}
                    spellCheck={false}
                    onChange={(event) => edit({ value: event.target.value })}
                  />
                ) : (
                  <SecretInput
                    id="vault-entry-value"
                    configured={entry !== null}
                    value={draft.value}
                    onChange={(event) => edit({ value: event.target.value })}
                  />
                )}
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="vault-entry-domains">Domains</Label>
                <Input
                  id="vault-entry-domains"
                  value={draft.domains}
                  placeholder="example.com"
                  autoComplete="off"
                  onChange={(event) => edit({ domains: event.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>Available in</Label>
                <ToggleGroup
                  aria-label="Available in"
                  value={[draft.scope === "global" ? "global" : "projects"]}
                  onValueChange={(values) => {
                    if (values[0] === "global") edit({ scope: "global" });
                    else if (values[0] === "projects" && draft.scope === "global")
                      edit({ scope: { projects: [] } });
                  }}
                >
                  <Toggle value="global">All projects</Toggle>
                  <Toggle value="projects" disabled={projects.length === 0}>
                    Chosen projects
                  </Toggle>
                </ToggleGroup>
                {draft.scope === "global" ? null : (
                  <div className="flex flex-col gap-1.5 pt-1">
                    {projects.map((project) => (
                      <Label key={project.id}>
                        <Checkbox
                          checked={
                            draft.scope !== "global" && draft.scope.projects.includes(project.id)
                          }
                          onCheckedChange={() =>
                            edit({ scope: toggleVaultScopeProject(draft.scope, project.id) })
                          }
                        />
                        {project.title}
                      </Label>
                    ))}
                  </div>
                )}
              </div>
              {shownError ? (
                <p role="alert" className="text-sm text-destructive">
                  {shownError}
                </p>
              ) : null}
            </fieldset>
          </DialogPanel>
          <DialogFooter>
            <DialogClose render={<Button variant="outline" size="sm" disabled={saving} />}>
              Cancel
            </DialogClose>
            <Button type="submit" size="sm" disabled={!canSave}>
              {entry === null ? "Add" : "Save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogPopup>
    </Dialog>
  );
}
