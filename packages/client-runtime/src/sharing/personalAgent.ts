import {
  agentRequestAwaitsOwner,
  isAgentRequestOpen,
  type AgentDecision,
  type AgentProposedAction,
  type AgentRequest,
} from "@t3tools/contracts";

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
