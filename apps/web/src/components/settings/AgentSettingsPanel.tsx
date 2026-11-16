import { useAtomValue } from "@effect/atom-react";
import { isSharedEnvironmentEntry } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  EMPTY_PERSONAL_AGENT_PERMISSIONS,
  PERSONAL_AGENT_CAPABILITIES,
  type PersonalAgentGrantMode,
  type PersonalAgentProjectCapability,
  type PersonalAgentProjectOverrides,
  PERSONAL_AGENT_INSTRUCTIONS_MAX_LENGTH,
  type EnvironmentId,
  type PersonalAgentPermissions,
  type PersonalAgentState,
  type ProjectId,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";

import { readLocalApi } from "~/localApi";
import { useProjects } from "~/state/entities";
import {
  useEnvironmentProviders,
  useEnvironments,
  usePrimaryEnvironmentId,
} from "~/state/environments";
import { personalAgent } from "~/state/personalAgent";
import { serverEnvironment } from "~/state/server";
import { useAtomCommand } from "~/state/use-atom-command";
import { AgentApprovalList } from "../personalAgent/AgentRequestCards";
import { Colleague, useOrganizationDirectory } from "../sharing/colleagues";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

/** Providers whose runtime can hold triage read-only; the server refuses any other. */
const READ_ONLY_DRIVERS = new Set(["codex", "claudeAgent"]);
/** Codex blocks writes and network but cannot confine reads to the ticked folders. */
const CONFINES_READS_DRIVERS = new Set(["claudeAgent"]);

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function AgentSettingsPanel() {
  const signedIn = useOrganizationDirectory() !== null;
  const relayState = useAtomValue(personalAgent.stateValueAtom);
  const { environments } = useEnvironments();
  const own = environments.filter((environment) => !isSharedEnvironmentEntry(environment.entry));
  const primary = usePrimaryEnvironmentId();
  const [selected, setSelected] = useState<EnvironmentId | null>(null);
  const environmentId = selected ?? primary ?? own[0]?.environmentId ?? null;
  const agentLabel =
    relayState.agent === null
      ? null
      : (environments.find(
          (environment) => environment.environmentId === relayState.agent?.environmentId,
        )?.label ?? "another environment");

  return (
    <SettingsPageContainer>
      <SettingsSection
        id={searchableSetting("personal-agent").id}
        title={searchableSetting("personal-agent").title}
      >
        {!signedIn ? (
          <SettingsRow title="Sign in to use a personal agent" />
        ) : (
          <>
            <CapabilitiesRow />
            <SettingsRow
              title="Where it runs"
              description={agentLabel === null ? "Off" : `On in ${agentLabel}`}
              control={relayState.agent !== null ? <RelayTurnOffButton /> : null}
            />
            {own.length > 1 ? (
              <SettingsRow
                title="Environment"
                control={
                  <Select
                    value={environmentId ?? ""}
                    onValueChange={(value) => {
                      if (value !== null) setSelected(value as EnvironmentId);
                    }}
                  >
                    <SelectTrigger
                      aria-label="Environment for the agent"
                      className="w-48"
                      size="sm"
                    >
                      <SelectValue>
                        {
                          own.find((environment) => environment.environmentId === environmentId)
                            ?.label
                        }
                      </SelectValue>
                    </SelectTrigger>
                    <SelectPopup>
                      {own.map((environment) => (
                        <SelectItem
                          key={environment.environmentId}
                          value={environment.environmentId}
                        >
                          {environment.label}
                        </SelectItem>
                      ))}
                    </SelectPopup>
                  </Select>
                }
              />
            ) : null}
            {environmentId === null ? null : (
              <EnvironmentAgentSettings key={environmentId} environmentId={environmentId} />
            )}
          </>
        )}
      </SettingsSection>
      {signedIn ? (
        <>
          <SettingsSection
            id={searchableSetting("agent-requests").id}
            title={searchableSetting("agent-requests").title}
          >
            <div className="px-4 py-3">
              <AgentApprovalList emptyText="No requests waiting for you." />
            </div>
          </SettingsSection>
          <BlockedPeopleSection blocked={relayState.blocked} />
        </>
      ) : null}
    </SettingsPageContainer>
  );
}

/** Works from any device, even while the agent's environment is offline. */
function RelayTurnOffButton() {
  const disable = useAtomCommand(personalAgent.disable, { reportFailure: false });
  return (
    <Button size="sm" variant="outline" onClick={() => void disable()}>
      Turn off
    </Button>
  );
}

function EnvironmentAgentSettings({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const getState = useAtomCommand(serverEnvironment.getPersonalAgent, { reportFailure: false });
  const setEnabled = useAtomCommand(serverEnvironment.setPersonalAgentEnabled, {
    reportFailure: false,
  });
  const setPermissions = useAtomCommand(serverEnvironment.setPersonalAgentPermissions, {
    reportFailure: false,
  });
  const configure = useAtomCommand(serverEnvironment.configurePersonalAgent, {
    reportFailure: false,
  });
  const refreshRelay = useAtomCommand(personalAgent.refresh, { reportFailure: false });
  const providers = (useEnvironmentProviders().get(environmentId) ?? []).filter(
    (provider) => provider.enabled && provider.installed && READ_ONLY_DRIVERS.has(provider.driver),
  );
  const [state, setState] = useState<PersonalAgentState | null>(null);
  const [draft, setDraft] = useState<PersonalAgentPermissions>(EMPTY_PERSONAL_AGENT_PERMISSIONS);
  const [instanceId, setInstanceId] = useState<string | null>(null);
  const [modelSlug, setModelSlug] = useState<string | null>(null);
  const [instructions, setInstructions] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apply = (result: Awaited<ReturnType<typeof getState>>) => {
    if (result._tag === "Success") {
      setState(result.value);
      setDraft(result.value.permissions);
      setError(null);
    } else if (!isAtomCommandInterrupted(result)) {
      setError(errorMessage(squashAtomCommandFailure(result), "Could not read the agent."));
    }
  };
  const applyOnOpen = useEffectEvent(apply);
  // oxlint-disable-next-line t3code/react-effect-budget -- reads the agent's settings from the chosen environment when it is shown
  useEffect(() => {
    void getState({ environmentId, input: {} }).then(applyOnOpen);
  }, [getState, environmentId]);

  const chosen =
    providers.find(
      (provider) => provider.instanceId === (instanceId ?? state?.providerInstanceId),
    ) ?? providers[0];
  const currentModel =
    state?.modelSelection?.instanceId === chosen?.instanceId ? state?.modelSelection?.model : null;
  const model =
    chosen?.models.find((candidate) => candidate.slug === (modelSlug ?? currentModel))?.slug ??
    chosen?.models.find((candidate) => candidate.isDefault === true)?.slug ??
    chosen?.models[0]?.slug;

  /** Applies at once while the agent runs; otherwise it is used when the agent is turned on. */
  const switchModel = async (nextInstanceId: ProviderInstanceId, nextModel: string | undefined) => {
    if (!state?.enabled || nextModel === undefined) return;
    setBusy(true);
    const result = await configure({
      environmentId,
      input: { modelSelection: { instanceId: nextInstanceId, model: nextModel } },
    });
    setBusy(false);
    apply(result);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: "Could not switch the agent's model",
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
    }
  };

  const saveInstructions = async () => {
    if (instructions === null) return;
    setBusy(true);
    const result = await configure({ environmentId, input: { instructions } });
    setBusy(false);
    apply(result);
    if (result._tag === "Success") {
      setInstructions(null);
      toastManager.add({ type: "success", title: "Instructions saved" });
    }
  };

  const toggle = async (enabled: boolean) => {
    setBusy(true);
    const result = await setEnabled({
      environmentId,
      input: {
        enabled,
        ...(enabled && chosen !== undefined && model !== undefined
          ? { modelSelection: { instanceId: chosen.instanceId, model } }
          : {}),
      },
    });
    setBusy(false);
    apply(result);
    void refreshRelay();
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add({
        type: "error",
        title: enabled ? "Could not turn the agent on" : "Could not turn the agent off",
        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
      });
    }
  };

  const save = async () => {
    setBusy(true);
    const result = await setPermissions({ environmentId, input: draft });
    setBusy(false);
    apply(result);
    if (result._tag === "Success")
      toastManager.add({ type: "success", title: "Permissions saved" });
  };

  if (error !== null) return <SettingsRow title="Could not read the agent" description={error} />;
  if (state === null) return null;
  return (
    <>
      <SettingsRow
        title="Personal agent in this environment"
        description={
          !state.relayLinked
            ? "Link this environment to fwai Connect first."
            : providers.length === 0
              ? "Needs Codex or Claude in this environment."
              : undefined
        }
        control={
          <Switch
            aria-label="Personal agent in this environment"
            checked={state.enabled}
            disabled={busy || !state.relayLinked || providers.length === 0}
            onCheckedChange={(checked) => void toggle(checked)}
          />
        }
      />
      {providers.length > 0 ? (
        <SettingsRow
          title="Provider and model"
          description={
            chosen !== undefined && !CONFINES_READS_DRIVERS.has(chosen.driver)
              ? "On Codex, a colleague's request can read any file your account can, not only what you allow below."
              : undefined
          }
          control={
            <span className="flex gap-2">
              <Select
                value={chosen?.instanceId ?? ""}
                onValueChange={(value) => {
                  if (value === null) return;
                  const next = providers.find((provider) => provider.instanceId === value);
                  setInstanceId(value);
                  setModelSlug(null);
                  if (next === undefined) return;
                  void switchModel(
                    next.instanceId,
                    next.models.find((candidate) => candidate.isDefault === true)?.slug ??
                      next.models[0]?.slug,
                  );
                }}
              >
                <SelectTrigger aria-label="Agent provider" className="w-32" size="sm">
                  <SelectValue>{chosen?.displayName ?? chosen?.instanceId}</SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {providers.map((provider) => (
                    <SelectItem key={provider.instanceId} value={provider.instanceId}>
                      {provider.displayName ?? provider.instanceId}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <Select
                value={model ?? ""}
                onValueChange={(value) => {
                  if (value === null || chosen === undefined) return;
                  setModelSlug(value);
                  void switchModel(chosen.instanceId, value);
                }}
              >
                <SelectTrigger aria-label="Agent model" className="w-40" size="sm">
                  <SelectValue>
                    {chosen?.models.find((candidate) => candidate.slug === model)?.name ?? model}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup>
                  {(chosen?.models ?? []).map((candidate) => (
                    <SelectItem key={candidate.slug} value={candidate.slug}>
                      {candidate.name}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </span>
          }
        />
      ) : null}
      <SettingsRow title="Your instructions">
        <Textarea
          aria-label="Your instructions for the agent"
          maxLength={PERSONAL_AGENT_INSTRUCTIONS_MAX_LENGTH}
          value={instructions ?? state.instructions}
          placeholder="e.g. I own the billing service. Point UI questions to @maria. Never share customer names."
          onChange={(event) => setInstructions(event.target.value)}
        />
        <div className="flex justify-end pt-2">
          <Button
            size="sm"
            disabled={busy || instructions === null || instructions === state.instructions}
            onClick={() => void saveInstructions()}
          >
            Save instructions
          </Button>
        </div>
      </SettingsRow>
      <PermissionsEditor environmentId={environmentId} value={draft} onChange={setDraft} />
      <SettingsRow
        title="Save permissions"
        control={
          <Button size="sm" disabled={busy} onClick={() => void save()}>
            Save
          </Button>
        }
      />
    </>
  );
}

function CapabilitiesRow() {
  return (
    <SettingsRow title="When a colleague asks">
      <div className="grid gap-3 pt-1 text-sm sm:grid-cols-2">
        <div>
          <p className="font-medium">It can</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {PERSONAL_AGENT_CAPABILITIES.can.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
        <div>
          <p className="font-medium">It cannot</p>
          <ul className="mt-1 list-disc space-y-1 pl-5 text-muted-foreground">
            {PERSONAL_AGENT_CAPABILITIES.cannot.map((line) => (
              <li key={line}>{line}</li>
            ))}
          </ul>
        </div>
      </div>
    </SettingsRow>
  );
}

const CAPABILITY_COLUMNS: ReadonlyArray<{
  readonly key: PersonalAgentProjectCapability;
  readonly label: string;
}> = [
  { key: "readFolder", label: "Read folder" },
  { key: "readThreads", label: "Read threads" },
  { key: "send", label: "Message threads" },
  { key: "start", label: "Start threads" },
];

const MODE_LABELS: Record<PersonalAgentGrantMode, string> = {
  auto: "Auto",
  ask: "Ask",
  deny: "Never",
};
const INHERIT = "inherit";

function ModeSelect<M extends string>({
  label,
  value,
  modes,
  inheritLabel,
  onChange,
}: {
  readonly label: string;
  readonly value: M | typeof INHERIT;
  readonly modes: ReadonlyArray<M>;
  readonly inheritLabel?: string;
  readonly onChange: (next: M | typeof INHERIT) => void;
}) {
  const text = (mode: M | typeof INHERIT) =>
    mode === INHERIT ? (inheritLabel ?? "") : MODE_LABELS[mode as PersonalAgentGrantMode];
  return (
    <Select<string>
      value={value}
      onValueChange={(next) => {
        if (next !== null) onChange(next as M | typeof INHERIT);
      }}
    >
      <SelectTrigger aria-label={label} className="w-24" size="sm">
        <SelectValue>{text(value)}</SelectValue>
      </SelectTrigger>
      <SelectPopup>
        {inheritLabel === undefined ? null : (
          <SelectItem value={INHERIT}>{inheritLabel}</SelectItem>
        )}
        {modes.map((mode) => (
          <SelectItem key={mode} value={mode}>
            {text(mode)}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}

const GRANT_MODES: ReadonlyArray<PersonalAgentGrantMode> = ["auto", "ask", "deny"];

function withProjectGrant(
  value: PersonalAgentPermissions,
  projectId: ProjectId,
  key: PersonalAgentProjectCapability,
  mode: PersonalAgentGrantMode | typeof INHERIT,
): PersonalAgentPermissions {
  const current = value.projects.find((entry) => entry.projectId === projectId)?.grants ?? {};
  const { [key]: _dropped, ...rest } = current;
  const grants: PersonalAgentProjectOverrides = mode === INHERIT ? rest : { ...rest, [key]: mode };
  const others = value.projects.filter((entry) => entry.projectId !== projectId);
  return {
    ...value,
    projects: Object.keys(grants).length === 0 ? others : [...others, { projectId, grants }],
  };
}

/**
 * What a colleague's request may use. "All my projects" covers projects added later; a project
 * row overrides it per column.
 */
function PermissionsEditor({
  environmentId,
  value,
  onChange,
}: {
  readonly environmentId: EnvironmentId;
  readonly value: PermissionsDraft;
  readonly onChange: (next: PermissionsDraft) => void;
}) {
  const projects = useProjects().filter(
    (project) => project.environmentId === environmentId && project.title !== "Personal agent",
  );
  const [folder, setFolder] = useState("");
  const addFolder = (path: string) => {
    const trimmed = path.trim().replace(/\/+$/u, "");
    if (!trimmed.startsWith("/") || value.extraReadPaths.includes(trimmed)) return;
    onChange({ ...value, extraReadPaths: [...value.extraReadPaths, trimmed] });
    setFolder("");
  };
  const chooseFolder = async () => {
    const picked = await readLocalApi()
      ?.dialogs.pickFolder()
      .catch(() => null);
    if (picked) addFolder(picked);
  };
  const canPick = typeof window !== "undefined" && window.desktopBridge !== undefined;
  return (
    <>
      <SettingsRow title="Projects">
        <table className="mt-1 w-full text-sm">
          <thead>
            <tr className="text-muted-foreground">
              <th className="py-1 text-left font-normal" />
              {CAPABILITY_COLUMNS.map((column) => (
                <th key={column.key} className="px-1 py-1 text-left font-normal">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="border-t">
              <td className="py-1 pr-2 font-medium">All projects</td>
              {CAPABILITY_COLUMNS.map((column) => (
                <td key={column.key} className="px-1 py-1">
                  <ModeSelect
                    label={`${column.label}, all projects`}
                    value={value.allProjects[column.key]}
                    modes={GRANT_MODES}
                    onChange={(mode) =>
                      mode !== INHERIT &&
                      onChange({
                        ...value,
                        allProjects: { ...value.allProjects, [column.key]: mode },
                      })
                    }
                  />
                </td>
              ))}
            </tr>
            {projects.map((project) => {
              const own = value.projects.find((entry) => entry.projectId === project.id)?.grants;
              return (
                <tr key={project.id} className="border-t">
                  <td className="max-w-40 truncate py-1 pr-2">{project.title}</td>
                  {CAPABILITY_COLUMNS.map((column) => (
                    <td key={column.key} className="px-1 py-1">
                      <ModeSelect
                        label={`${column.label}, ${project.title}`}
                        value={own?.[column.key] ?? INHERIT}
                        modes={GRANT_MODES}
                        inheritLabel={`= ${MODE_LABELS[value.allProjects[column.key]]}`}
                        onChange={(mode) =>
                          onChange(withProjectGrant(value, project.id, column.key, mode))
                        }
                      />
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </SettingsRow>
      <SettingsRow
        title="Reply to the colleague"
        control={
          <ModeSelect
            label="Reply to the colleague"
            value={value.reply}
            modes={["auto", "ask"] as const}
            onChange={(mode) => mode !== INHERIT && onChange({ ...value, reply: mode })}
          />
        }
      />
      <SettingsRow
        title="Share a thread"
        control={
          <ModeSelect
            label="Share a thread"
            value={value.share}
            modes={["ask", "deny"] as const}
            onChange={(mode) => mode !== INHERIT && onChange({ ...value, share: mode })}
          />
        }
      />
      <SettingsRow
        title="Read its memory"
        control={
          <Switch
            aria-label="Read its memory"
            checked={value.readMemory}
            onCheckedChange={(on) => onChange({ ...value, readMemory: on })}
          />
        }
      />
      <SettingsRow
        title="Earlier requests from the same colleague"
        control={
          <Switch
            aria-label="Earlier requests from the same colleague"
            checked={value.usePriorRequests}
            onCheckedChange={(on) => onChange({ ...value, usePriorRequests: on })}
          />
        }
      />
      <SettingsRow title="Other folders">
        <div className="flex flex-col gap-1 pt-1">
          {value.extraReadPaths.map((path) => (
            <div key={path} className="flex items-center gap-2 text-sm">
              <span className="min-w-0 flex-1 truncate font-mono">{path}</span>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  onChange({
                    ...value,
                    extraReadPaths: value.extraReadPaths.filter((entry) => entry !== path),
                  })
                }
              >
                Remove
              </Button>
            </div>
          ))}
          <div className="flex gap-2">
            {canPick ? (
              <Button size="sm" variant="outline" onClick={() => void chooseFolder()}>
                Choose…
              </Button>
            ) : null}
            <Input
              aria-label="Folder path"
              className="flex-1"
              value={folder}
              placeholder="/absolute/path"
              onChange={(event) => setFolder(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addFolder(folder);
              }}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!folder.trim().startsWith("/")}
              onClick={() => addFolder(folder)}
            >
              Add
            </Button>
          </div>
        </div>
      </SettingsRow>
    </>
  );
}

type PermissionsDraft = PersonalAgentPermissions;

function BlockedPeopleSection({ blocked }: { readonly blocked: ReadonlyArray<string> }) {
  const setBlocked = useAtomCommand(personalAgent.setBlocked, { reportFailure: false });
  const directory = useOrganizationDirectory();
  const [name, setName] = useState("");
  const block = async () => {
    if (directory === null) return;
    const wanted = name.trim().replace(/^@/u, "").toLowerCase();
    const page = await directory.searchMembers({ q: wanted, limit: 20 }).catch(() => null);
    const member = page?.members.find((candidate) => candidate.username.toLowerCase() === wanted);
    if (member === undefined) {
      toastManager.add({
        type: "error",
        title: `No one named "${name.trim()}" in your organization`,
      });
      return;
    }
    await setBlocked({ accountId: member.user_id, blocked: true });
    setName("");
  };
  return (
    <SettingsSection
      id={searchableSetting("agent-blocked").id}
      title={searchableSetting("agent-blocked").title}
    >
      <SettingsRow
        title="Block someone"
        control={
          <span className="flex gap-2">
            <Input
              aria-label="Username to block"
              className="w-40"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="username"
            />
            <Button
              size="sm"
              variant="outline"
              disabled={name.trim() === ""}
              onClick={() => void block()}
            >
              Block
            </Button>
          </span>
        }
      />
      {blocked.map((accountId) => (
        <SettingsRow
          key={accountId}
          title={<Colleague userId={accountId} />}
          control={
            <Button
              size="sm"
              variant="ghost"
              onClick={() => void setBlocked({ accountId, blocked: false })}
            >
              Unblock
            </Button>
          }
        />
      ))}
    </SettingsSection>
  );
}
