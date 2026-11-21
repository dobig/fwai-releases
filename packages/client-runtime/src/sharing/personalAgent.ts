import {
  agentRequestAwaitsOwner,
  isAgentRequestOpen,
  type AgentDecision,
  type AgentProposedAction,
  type AgentRequest,
  type PersonalAgentGrantMode,
  type PersonalAgentPermissions,
  type PersonalAgentProjectCapability,
  type PersonalAgentProjectOverrides,
  type PersonalAgentState,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";

import type { FwaiOrganizationDirectory } from "./organizationDirectory.ts";

/** `/ask <username> <body>`: usernames have no spaces, the rest of the message is the body. */
export function parseAskCommand(
  text: string,
): { readonly username: string; readonly body: string } | null {
  const match = /^\/ask(?:\s+(\S+))?(?:\s+([^]*))?$/i.exec(text.trim());
  if (!match) return null;
  return { username: (match[1] ?? "").replace(/^@/u, ""), body: (match[2] ?? "").trim() };
}

/** While the name is still being typed: `/ask al` (no space after it yet). */
export const ASK_TARGET_TRIGGER = /^\/ask[ \t]+(\S*)$/i;

/** The request cards one thread shows: what it asked, newest first. */
export function requestsForThread(
  outbox: ReadonlyArray<AgentRequest>,
  thread: { readonly environmentId: string; readonly threadId: string },
): ReadonlyArray<AgentRequest> {
  return [...outbox]
    .filter(
      (request) =>
        request.from.environmentId === thread.environmentId &&
        request.from.threadId === thread.threadId &&
        // Outcomes land in the thread as a message; the card only tracks what is still open.
        isAgentRequestOpen(request.status),
    )
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

/** Requests waiting for this person to accept, edit, forward or reject. */
export function requestsAwaitingDecision(
  inbox: ReadonlyArray<AgentRequest>,
): ReadonlyArray<AgentRequest> {
  return inbox.filter(agentRequestAwaitsOwner);
}

/** One line for a request's state, as the requester sees it. */
export function requesterStatusLabel(request: AgentRequest): string {
  switch (request.status) {
    case "pending":
      return "Waiting for their approval";
    case "accepted":
      return request.execution?.state === "running"
        ? "Accepted, being worked on"
        : request.execution?.state === "done" || request.execution?.state === "failed"
          ? "Accepted, answer being prepared"
          : "Accepted, waiting for their agent's environment";
    case "replied":
      return "Answered";
    case "rejected":
      return "Declined";
    case "forwarded":
      return "Forwarded to a colleague";
    case "expired":
      return "Expired without an answer";
    case "cancelled":
      return "Cancelled";
  }
}

export function actionLabel(action: AgentProposedAction): string {
  switch (action.kind) {
    case "answer":
      return "Answer";
    case "grant_access":
      return action.needs.length === 1
        ? "Read 1 project item"
        : `Read ${action.needs.length} project items`;
    case "send_to_thread":
      return "Send to one of my threads";
    case "start_thread":
      return "Start a thread";
    case "share_thread":
      return `Share a thread as ${action.role}`;
    case "forward":
      return "Forward to a colleague";
    case "decline":
      return "Decline";
  }
}

/** Accepting what the card shows, with the owner's edits to the text. */
/**
 * Approving the card's text. A proposed decline still sends that text as an answer: declining is
 * Reject, never a side effect of approving written text.
 */
/**
 * The task a send or start asks of a thread's agent, for the card to edit; null for other
 * actions. A send proposed before `task` existed carried it in the draft.
 */
export function proposedTask(request: AgentRequest): string | null {
  const action = request.proposal?.action;
  if (action?.kind === "send_to_thread") return action.task ?? request.proposal?.draft ?? "";
  if (action?.kind === "start_thread") return action.task ?? "";
  return null;
}

/**
 * `text` is the owner's words to the colleague; `task`, when the card edits one, replaces the
 * proposed action's task. An empty task on a start only opens the thread.
 */
export function acceptDecision(request: AgentRequest, text: string, task?: string): AgentDecision {
  const proposed = request.proposal?.action;
  // After granted access the request may still go on to an action; after other work, only text.
  const workRan = request.status === "accepted" && request.decision?.action.kind !== "grant_access";
  const chosen: AgentProposedAction =
    workRan || proposed === undefined || proposed.kind === "decline"
      ? { kind: "answer" }
      : proposed;
  const action = withTask(chosen, task);
  return action.kind === "forward"
    ? { decision: "forward", toAccountId: action.toAccountId, text }
    : { decision: "accept", action, text };
}

function withTask(action: AgentProposedAction, task: string | undefined): AgentProposedAction {
  if (task === undefined) return action;
  if (action.kind !== "send_to_thread" && action.kind !== "start_thread") return action;
  const { task: _previous, ...rest } = action;
  const trimmed = task.trim();
  return trimmed === "" ? rest : { ...rest, task: trimmed };
}

/** The owner may point an approved send at another thread; the environment re-checks it. */
export function withSendTarget(decision: AgentDecision, threadId: ThreadId | null): AgentDecision {
  return threadId !== null &&
    decision.decision === "accept" &&
    decision.action.kind === "send_to_thread"
    ? { ...decision, action: { ...decision.action, threadId } }
    : decision;
}

/** Providers whose runtime can hold triage read-only; the server refuses any other. */
export const PERSONAL_AGENT_READ_ONLY_DRIVERS: ReadonlySet<string> = new Set([
  "codex",
  "claudeAgent",
]);
/** Codex blocks writes and network but cannot confine reads to the allowed folders. */
export const PERSONAL_AGENT_CONFINES_READS_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);

interface AgentProviderChoice {
  readonly instanceId: string;
  readonly models: ReadonlyArray<{
    readonly slug: string;
    readonly isDefault?: boolean | undefined;
  }>;
}

/**
 * The provider and model the settings show: what the owner picked, else what the agent runs,
 * else the first provider and its default model.
 */
export function chooseAgentModel<P extends AgentProviderChoice>(
  providers: ReadonlyArray<P>,
  picked: { readonly instanceId: string | null; readonly model: string | null },
  state: Pick<PersonalAgentState, "providerInstanceId" | "modelSelection"> | null,
): { readonly provider: P | undefined; readonly model: string | undefined } {
  const provider =
    providers.find(
      (candidate) => candidate.instanceId === (picked.instanceId ?? state?.providerInstanceId),
    ) ?? providers[0];
  const running =
    state?.modelSelection?.instanceId === provider?.instanceId
      ? state?.modelSelection?.model
      : null;
  const model =
    provider?.models.find((candidate) => candidate.slug === (picked.model ?? running))?.slug ??
    defaultAgentModel(provider);
  return { provider, model };
}

export function defaultAgentModel(provider: AgentProviderChoice | undefined): string | undefined {
  return (
    provider?.models.find((candidate) => candidate.isDefault === true)?.slug ??
    provider?.models[0]?.slug
  );
}

/** A project row's grant changed; `"inherit"` drops it back to the all-projects row. */
export function withProjectGrant(
  value: PersonalAgentPermissions,
  projectId: ProjectId,
  key: PersonalAgentProjectCapability,
  mode: PersonalAgentGrantMode | "inherit",
): PersonalAgentPermissions {
  const current = value.projects.find((entry) => entry.projectId === projectId)?.grants ?? {};
  const { [key]: _dropped, ...rest } = current;
  const grants: PersonalAgentProjectOverrides =
    mode === "inherit" ? rest : { ...rest, [key]: mode };
  const others = value.projects.filter((entry) => entry.projectId !== projectId);
  return {
    ...value,
    projects: Object.keys(grants).length === 0 ? others : [...others, { projectId, grants }],
  };
}

/** Adds an absolute folder the agent may read; the same permissions when it is not one. */
export function withExtraReadPath(
  value: PersonalAgentPermissions,
  path: string,
): PersonalAgentPermissions {
  const trimmed = path.trim().replace(/\/+$/u, "");
  if (!trimmed.startsWith("/") || value.extraReadPaths.includes(trimmed)) return value;
  return { ...value, extraReadPaths: [...value.extraReadPaths, trimmed] };
}

/** The organization member with exactly this username (a leading @ is fine), if any. */
export async function findOrganizationMember(
  directory: Pick<FwaiOrganizationDirectory, "searchMembers">,
  username: string,
) {
  const wanted = username.trim().replace(/^@/u, "").toLowerCase();
  const page = await directory.searchMembers({ q: wanted, limit: 20 }).catch(() => null);
  return page?.members.find((candidate) => candidate.username.toLowerCase() === wanted);
}
