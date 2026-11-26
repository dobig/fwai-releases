import {
  VAULT_DOMAINS_MAX,
  VAULT_NAME_MAX_LENGTH,
  VAULT_VALUE_MAX_LENGTH,
  type ProjectId,
  type VaultCreateInput,
  type VaultDelivery,
  type VaultEntryKind,
  type VaultEntrySummary,
  type VaultMatchesForRequestResult,
  type VaultSaveFromRequest,
  type VaultScope,
  type VaultSyncEnvironment,
  type VaultSyncState,
  type VaultSyncStatus,
  type VaultUpdateInput,
} from "@t3tools/contracts";

/** The Settings form. `value` is always empty when editing: a stored value never reaches a client. */
export interface VaultDraft {
  readonly name: string;
  readonly kind: VaultEntryKind;
  readonly username: string;
  /** As typed: hosts or URLs separated by commas, spaces or new lines. */
  readonly domains: string;
  readonly scope: VaultScope;
  readonly value: string;
}

export const EMPTY_VAULT_DRAFT: VaultDraft = {
  name: "",
  kind: "password",
  username: "",
  domains: "",
  scope: "global",
  value: "",
};

export const VAULT_KIND_LABELS: Readonly<Record<VaultEntryKind, string>> = {
  password: "Password",
  token: "Token",
  note: "Note",
};

export const VAULT_DELIVERY_LABELS: Readonly<Record<VaultDelivery, string>> = {
  secretRef: "As a reference",
  file: "As a file",
  form_fill: "Typed into a page",
};

export function vaultDraftFromEntry(entry: VaultEntrySummary): VaultDraft {
  return {
    name: entry.name,
    kind: entry.kind,
    username: entry.username ?? "",
    domains: entry.domains.join(", "),
    scope: entry.scope,
    value: "",
  };
}

function hostOf(token: string): string {
  const withoutScheme = token.replace(/^[a-z][a-z0-9+.-]*:\/\//i, "");
  const host = withoutScheme.split(/[/?#]/, 1)[0] ?? "";
  return host.replace(/:\d+$/, "").replace(/\.$/, "").toLowerCase();
}

/** Hosts from what the user typed; a pasted URL keeps only its host. */
export function parseVaultDomains(text: string): string[] {
  const hosts = text
    .split(/[\s,]+/)
    .map(hostOf)
    .filter((host) => host !== "");
  return [...new Set(hosts)];
}

/** What a name left empty becomes: the first domain, for a password. */
function vaultNameFallback(draft: Pick<VaultDraft, "kind" | "domains">): string | undefined {
  return draft.kind === "password" ? parseVaultDomains(draft.domains)[0] : undefined;
}

export function vaultNamePlaceholder(draft: Pick<VaultDraft, "kind" | "domains">): string {
  if (draft.kind === "token") return "GITHUB_TOKEN";
  return vaultNameFallback(draft) ?? "Name";
}

function resolvedName(draft: VaultDraft): string {
  return draft.name.trim() || vaultNameFallback(draft) || "";
}

/** A token has no username, so switching to one drops it. */
function resolvedUsername(draft: VaultDraft): string {
  return draft.kind === "token" ? "" : draft.username.trim();
}

export type VaultDraftIssue =
  /** A required field is empty; the form only disables Save. */
  { readonly kind: "incomplete" } | { readonly kind: "invalid"; readonly message: string };

export function vaultDraftIssue(
  draft: VaultDraft,
  mode: "create" | "edit",
): VaultDraftIssue | null {
  const name = resolvedName(draft);
  if (name === "" || (mode === "create" && draft.value === "")) return { kind: "incomplete" };
  if (name.length > VAULT_NAME_MAX_LENGTH) {
    return { kind: "invalid", message: `Use at most ${VAULT_NAME_MAX_LENGTH} characters.` };
  }
  if (draft.value.length > VAULT_VALUE_MAX_LENGTH) {
    return { kind: "invalid", message: "That value is too long." };
  }
  if (parseVaultDomains(draft.domains).length > VAULT_DOMAINS_MAX) {
    return { kind: "invalid", message: `Use at most ${VAULT_DOMAINS_MAX} domains.` };
  }
  if (draft.scope !== "global" && draft.scope.projects.length === 0) {
    return { kind: "invalid", message: "Choose at least one project." };
  }
  return null;
}

export function vaultCreateInput(draft: VaultDraft): VaultCreateInput {
  const username = resolvedUsername(draft);
  return {
    name: resolvedName(draft),
    kind: draft.kind,
    ...(username === "" ? {} : { username }),
    domains: parseVaultDomains(draft.domains),
    scope: draft.scope,
    value: draft.value,
  };
}

function sameScope(left: VaultScope, right: VaultScope): boolean {
  if (left === "global" || right === "global") return left === right;
  const ids = new Set<ProjectId>(left.projects);
  return ids.size === new Set(right.projects).size && right.projects.every((id) => ids.has(id));
}

function sameList(left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean {
  return left.length === right.length && left.every((item, index) => item === right[index]);
}

/**
 * Only what changed. An empty value keeps the stored one; a cleared username is sent as `null`.
 * Returns `null` when nothing changed.
 */
export function vaultUpdateInput(
  entry: VaultEntrySummary,
  draft: VaultDraft,
): VaultUpdateInput | null {
  const name = resolvedName(draft);
  const username = resolvedUsername(draft);
  const domains = parseVaultDomains(draft.domains);
  const input: VaultUpdateInput = {
    id: entry.id,
    ...(name === entry.name ? {} : { name }),
    ...(draft.kind === entry.kind ? {} : { kind: draft.kind }),
    ...(username === (entry.username ?? "") ? {} : { username: username === "" ? null : username }),
    ...(sameList(domains, entry.domains) ? {} : { domains }),
    ...(sameScope(draft.scope, entry.scope) ? {} : { scope: draft.scope }),
    ...(draft.value === "" ? {} : { value: draft.value }),
  };
  return Object.keys(input).length === 1 ? null : input;
}

export function toggleVaultScopeProject(scope: VaultScope, projectId: ProjectId): VaultScope {
  const projects = scope === "global" ? [] : scope.projects;
  return {
    projects: projects.includes(projectId)
      ? projects.filter((id) => id !== projectId)
      : [...projects, projectId],
  };
}

export function vaultScopeLabel(
  scope: VaultScope,
  projectTitle: (projectId: ProjectId) => string | undefined,
): string {
  if (scope === "global") return "All projects";
  return scope.projects.map((id) => projectTitle(id) ?? "Removed project").join(", ");
}

export function sortVaultEntries(
  entries: ReadonlyArray<VaultEntrySummary>,
): ReadonlyArray<VaultEntrySummary> {
  return [...entries].sort((left, right) =>
    left.name.localeCompare(right.name, undefined, { sensitivity: "base" }),
  );
}

/** A request card's **Save to vault** form, prefilled from what the server suggested. */
export function vaultDraftForRequest(
  suggestions: Pick<VaultMatchesForRequestResult, "suggestedName" | "suggestedDomains">,
): VaultDraft {
  return {
    ...EMPTY_VAULT_DRAFT,
    name: suggestions.suggestedName ?? "",
    domains: suggestions.suggestedDomains.join(", "),
  };
}

/** The card's own input carries the value, so the draft's `value` is ignored. */
export function vaultSaveFromRequestIssue(draft: VaultDraft): VaultDraftIssue | null {
  return vaultDraftIssue({ ...draft, value: "" }, "edit");
}

export function vaultSaveFromRequest(draft: VaultDraft): VaultSaveFromRequest {
  const { value: _value, ...save } = vaultCreateInput(draft);
  return save;
}

export function vaultEntryDetails(entry: Pick<VaultEntrySummary, "username" | "domains">): string {
  return [entry.username, entry.domains.join(", ")].filter(Boolean).join(" · ");
}

/** Shown wherever sync is offered: what fwai Connect can and cannot do with the vault. */
export const VAULT_SYNC_NOTICE =
  "Secrets are stored only on your machines. fwai can't read or restore them: if you lose every machine that has them, they can't be recovered.";

export const VAULT_SYNC_JOIN_CHOICE_LABEL = "Share secrets with my other machines";
export const VAULT_SYNC_JOIN_CHOICE_DESCRIPTION =
  "Allow this machine to use the secrets saved on your other machines signed in to this account.";

export const VAULT_SYNC_STATE_PRESENTATION: Readonly<
  Record<VaultSyncState, { readonly label: string; readonly description?: string }>
> = {
  unavailable: {
    label: "Not available",
    description: "Link this environment through fwai Connect to sync secrets.",
  },
  off: { label: "Off" },
  waiting: {
    label: "Waiting",
    description: "Waiting for another of your machines to come online.",
  },
  on: { label: "On" },
  needs_rejoin: {
    label: "Needs rejoining",
    description:
      "This machine's sync keys are missing. Rejoin while another of your machines is online.",
  },
};

export type VaultSyncAction = "join" | "leave" | "turnOff" | "rotate" | "revoke";

/** `join` is **Rejoin** in `needs_rejoin`. Leaving is always possible once joined. */
/** The "Share secrets with my other machines" switch: on once this machine has joined. */
export function vaultSyncShared(state: VaultSyncState): boolean {
  return state === "waiting" || state === "on" || state === "needs_rejoin";
}

export function vaultSyncActions(state: VaultSyncState): ReadonlyArray<VaultSyncAction> {
  switch (state) {
    case "unavailable":
      return [];
    case "off":
      return ["join"];
    case "waiting":
      return ["leave"];
    case "needs_rejoin":
      return ["join", "leave"];
    case "on":
      return ["revoke", "rotate", "leave", "turnOff"];
  }
}

export function vaultSyncProblemMessage(problem: NonNullable<VaultSyncStatus["problem"]>): string {
  const entry = problem.entryName ?? "An entry";
  switch (problem.reason) {
    case "relay_unreachable":
      return "Could not reach fwai Connect. Sync resumes when it is reachable.";
    case "quota_entry_size":
      return `${entry} is over 64 KB and does not sync.`;
    case "quota_entry_count":
      return "Sync holds at most 1000 entries. New entries stay on this machine.";
    case "quota_total_size":
      return "Synced entries are over 10 MB in total. New changes stay on this machine.";
  }
}

export function vaultSyncPendingLabel(pendingUploads: number): string | null {
  if (pendingUploads <= 0) return null;
  return pendingUploads === 1
    ? "1 change waiting to upload"
    : `${pendingUploads} changes waiting to upload`;
}

export interface VaultSyncEnvironmentRow {
  readonly environmentId: VaultSyncEnvironment["environmentId"];
  readonly label: string;
  readonly detail: string | undefined;
  readonly canRevoke: boolean;
}

/** This machine first, then the others by name; unknown environments get a generic name. */
export function vaultSyncEnvironmentRows(
  status: Pick<VaultSyncStatus, "state" | "environments">,
  labelOf: (environmentId: VaultSyncEnvironment["environmentId"]) => string | undefined,
): ReadonlyArray<VaultSyncEnvironmentRow> {
  const canRevoke = vaultSyncActions(status.state).includes("revoke");
  return status.environments
    .map((environment) => ({
      environmentId: environment.environmentId,
      label: labelOf(environment.environmentId) ?? "Another machine",
      detail: environment.isThis
        ? "This machine"
        : environment.hasKey
          ? undefined
          : "Waiting for its key",
      canRevoke: canRevoke && !environment.isThis,
      isThis: environment.isThis,
    }))
    .sort((left, right) =>
      left.isThis !== right.isThis
        ? left.isThis
          ? -1
          : 1
        : left.label.localeCompare(right.label, undefined, { sensitivity: "base" }),
    )
    .map(({ isThis: _isThis, ...row }) => row);
}

/** `relative` is the client's own rendering of `previous.replacedAt`, such as "2h ago". */
export function vaultPreviousVersionLabel(
  previous: NonNullable<VaultEntrySummary["previous"]>,
  relative: string,
): string {
  return previous.reason === "deleted"
    ? "Deleted on another machine"
    : `Replaced by a newer change ${relative}`;
}

export interface VaultSyncConfirmation {
  readonly title: string;
  readonly message: string;
  readonly confirmText: string;
  readonly destructive: boolean;
}

export const vaultSyncConfirmations = {
  revoke: (machine: string): VaultSyncConfirmation => ({
    title: `Revoke ${machine}?`,
    message:
      "It stops receiving changes, but it may still hold the values it already has. Change those passwords.",
    confirmText: "Revoke",
    destructive: true,
  }),
  rotate: {
    title: "Rotate the sync key?",
    message:
      "Do this if the key may have been read on one of your machines, for example by an agent. Every joined machine gets the new key.",
    confirmText: "Rotate key",
    destructive: false,
  },
  turnOff: {
    title: "Turn off sync everywhere?",
    message: "This deletes the synced copies in fwai Connect. Every machine keeps its own entries.",
    confirmText: "Turn off",
    destructive: true,
  },
} as const;
