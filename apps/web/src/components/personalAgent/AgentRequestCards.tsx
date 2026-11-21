import { useAtomValue } from "@effect/atom-react";
import {
  acceptDecision,
  actionLabel,
  findOrganizationMember,
  proposedTask,
  requestsAwaitingDecision,
  requestsForThread,
  requesterStatusLabel,
  withSendTarget,
} from "@t3tools/client-runtime/sharing/personal-agent";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  AgentDecision,
  AgentProposedAction,
  AgentRequest,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useProjects, useQuietThreadShells } from "~/state/entities";
import { personalAgent } from "~/state/personalAgent";
import { useAtomCommand } from "~/state/use-atom-command";
import { Colleague, useOrganizationDirectory } from "../sharing/colleagues";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

/** Requests waiting for the signed-in person's decision; empty without any. */
export function AgentApprovalList({ emptyText }: { readonly emptyText?: string }) {
  const state = useAtomValue(personalAgent.stateValueAtom);
  const awaiting = requestsAwaitingDecision(state.inbox);
  if (awaiting.length === 0) {
    return emptyText === undefined ? null : (
      <p className="text-muted-foreground text-sm">{emptyText}</p>
    );
  }
  return (
    <ul className="flex flex-col gap-3" aria-label="Requests to your agent">
      {awaiting.map((request) => (
        <li key={`${request.id}:${request.updatedAt}`}>
          <AgentApprovalCard request={request} />
        </li>
      ))}
    </ul>
  );
}

/**
 * One request to approve. What it shows comes from the relay, so it works from any device while
 * the agent's environment is offline; the agent's draft, if any, is only a starting point.
 */
export function AgentApprovalCard({ request }: { readonly request: AgentRequest }) {
  const decide = useAtomCommand(personalAgent.decide, { reportFailure: false });
  const directory = useOrganizationDirectory();
  const proposal = request.proposal;
  const [text, setText] = useState(proposal?.draft ?? "");
  const [task, setTask] = useState(() => proposedTask(request));
  const [targetThreadId, setTargetThreadId] = useState<ThreadId | null>(null);
  const targets = useSendTargets(proposal?.action ?? null);
  const projectTitles = new Map(useProjects().map((project) => [project.id, project.title]));
  const [mode, setMode] = useState<"idle" | "reject" | "forward">("idle");
  const [reason, setReason] = useState("");
  const [forwardTo, setForwardTo] = useState("");
  const [busy, setBusy] = useState(false);

  const send = async (decision: AgentDecision, done: string) => {
    setBusy(true);
    const result = await decide({ requestId: request.id, decision });
    setBusy(false);
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: done });
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    toastManager.add({
      type: "error",
      title: "Could not record your decision",
      description: errorMessage(squashAtomCommandFailure(result), "Try again."),
    });
  };

  const forward = async () => {
    if (directory === null) return;
    const name = forwardTo.trim().replace(/^@/u, "");
    const member = await findOrganizationMember(directory, name);
    if (member === undefined) {
      toastManager.add({ type: "error", title: `No one named "${name}" in your organization` });
      return;
    }
    await send(
      { decision: "forward", toAccountId: member.user_id, text: text.trim() || request.body },
      `Forwarded to ${member.username}`,
    );
  };

  const afterWork =
    request.status === "accepted" && request.decision?.action.kind !== "grant_access";
  const asksAccess = !afterWork && proposal?.action.kind === "grant_access";
  // Approving does what the agent proposed only for real actions; answer and decline send text.
  const proposesAction =
    !afterWork &&
    proposal !== null &&
    proposal.action.kind !== "answer" &&
    proposal.action.kind !== "decline";
  // A send or start hands a task to a thread's agent; the colleague hears back after the work.
  const editsTask = proposesAction && task !== null;
  const needsTask = editsTask && proposal?.action.kind === "send_to_thread";
  const hasTask = editsTask && task.trim() !== "";
  const showsReply = !asksAccess && !hasTask && !needsTask;
  return (
    <article className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <header className="flex flex-wrap items-center gap-1 text-muted-foreground">
        <Colleague userId={request.from.accountId} />
        <span>{request.forwardedFrom === null ? "asks" : "asks (forwarded)"}</span>
        {request.from.threadTitle ? <span>· from “{request.from.threadTitle}”</span> : null}
      </header>
      <blockquote className="whitespace-pre-wrap border-l-2 pl-2 text-foreground">
        {request.body}
      </blockquote>
      {proposal === null ? (
        <p className="text-muted-foreground">
          Your agent has not prepared a proposal yet. You can still answer or reject it.
        </p>
      ) : (
        <div className="flex flex-col gap-1">
          <p>{proposal.summary}</p>
          <p className="text-muted-foreground">
            {afterWork
              ? "The approved work finished. Proposed answer:"
              : `Proposed: ${actionLabel(proposal.action)}`}
          </p>
          {proposal.action.kind === "grant_access" && !afterWork ? (
            <ul className="list-disc pl-5">
              {proposal.action.needs.map((need) => (
                <li key={`${need.kind}:${need.projectId}`}>
                  {need.kind === "read_folder" ? "Read the folder of " : "Read the threads of "}
                  {projectTitles.get(need.projectId) ?? need.projectId}
                </li>
              ))}
            </ul>
          ) : null}
          {proposal.suspicious.length > 0 ? (
            <div role="alert" className="rounded-md border border-warning/40 bg-warning/8 p-2">
              <p className="font-medium">Suspicious instructions in the request (not followed):</p>
              <ul className="list-disc pl-5">
                {proposal.suspicious.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="font-medium">The reply would disclose:</p>
            {proposal.disclosure.length === 0 ? (
              <p className="text-muted-foreground">Nothing beyond the reply text.</p>
            ) : (
              <ul className="list-disc pl-5">
                {proposal.disclosure.map((item) => (
                  <li key={item}>{item}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
      {targets.length > 1 && proposal?.action.kind === "send_to_thread" ? (
        <label className="flex items-center gap-2">
          <span className="text-muted-foreground">Send to</span>
          <Select
            value={targetThreadId ?? proposal.action.threadId}
            onValueChange={(value) => {
              if (value !== null) setTargetThreadId(value as ThreadId);
            }}
          >
            <SelectTrigger aria-label="Thread to send the work to" className="w-64" size="sm">
              <SelectValue>
                {targets.find(
                  (thread) =>
                    thread.id ===
                    (targetThreadId ??
                      (proposal.action.kind === "send_to_thread"
                        ? proposal.action.threadId
                        : null)),
                )?.title ?? "Thread"}
              </SelectValue>
            </SelectTrigger>
            <SelectPopup>
              {targets.map((thread) => (
                <SelectItem key={thread.id} value={thread.id}>
                  {thread.title || "Untitled thread"}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </label>
      ) : null}
      {editsTask ? (
        <Textarea
          aria-label="Task for the thread"
          value={task}
          onChange={(event) => setTask(event.target.value)}
          placeholder={
            needsTask ? "What that thread's agent should do" : "Leave empty to only open the thread"
          }
        />
      ) : null}
      {showsReply ? (
        <Textarea
          aria-label="Reply to your colleague"
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="What to send. Only this text leaves, never the request as written."
        />
      ) : null}
      {mode === "reject" ? (
        <div className="flex gap-2">
          <Input
            aria-label="Reason (optional)"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
            placeholder="Reason (optional)"
          />
          <Button
            size="sm"
            variant="destructive"
            disabled={busy}
            onClick={() =>
              void send(
                { decision: "reject", ...(reason.trim() ? { reason: reason.trim() } : {}) },
                "Rejected",
              )
            }
          >
            Reject
          </Button>
        </div>
      ) : null}
      {mode === "forward" ? (
        <div className="flex gap-2">
          <Input
            aria-label="Colleague's username"
            value={forwardTo}
            onChange={(event) => setForwardTo(event.target.value)}
            placeholder="Colleague's username"
          />
          <Button
            size="sm"
            disabled={busy || forwardTo.trim() === ""}
            onClick={() => void forward()}
          >
            Forward
          </Button>
        </div>
      ) : null}
      <footer className="flex flex-wrap justify-end gap-2">
        <Button
          size="sm"
          variant="ghost"
          disabled={busy}
          onClick={() => setMode(mode === "reject" ? "idle" : "reject")}
        >
          Reject…
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy}
          onClick={() => setMode(mode === "forward" ? "idle" : "forward")}
        >
          Forward…
        </Button>
        {proposesAction && showsReply ? (
          <Button
            size="sm"
            variant="outline"
            disabled={busy || text.trim() === ""}
            onClick={() =>
              void send(
                { decision: "accept", action: { kind: "answer" }, text: text.trim() },
                "Answer sent",
              )
            }
          >
            Send as answer
          </Button>
        ) : null}
        <Button
          size="sm"
          disabled={
            busy ||
            (needsTask && !hasTask) ||
            (!proposesAction && !asksAccess && text.trim() === "")
          }
          onClick={() =>
            void send(
              withSendTarget(
                acceptDecision(request, text.trim(), editsTask ? task : undefined),
                targetThreadId,
              ),
              proposesAction ? "Accepted" : "Answer sent",
            )
          }
        >
          {asksAccess
            ? "Grant access"
            : proposesAction
              ? `Accept: ${actionLabel(proposal.action)}`
              : "Send answer"}
        </Button>
      </footer>
    </article>
  );
}

/**
 * Live threads in the proposed thread's project, on the agent's environment, when this client is
 * connected to it. Elsewhere (a phone, the environment offline) the proposed thread stands.
 */
function useSendTargets(action: AgentProposedAction | null) {
  const agent = useAtomValue(personalAgent.stateValueAtom).agent;
  const threads = useQuietThreadShells();
  if (action?.kind !== "send_to_thread" || agent === null) return [];
  const local = threads.filter(
    (thread) =>
      thread.environmentId === agent.environmentId &&
      thread.archivedAt === null &&
      thread.id !== agent.threadId,
  );
  const projectId = local.find((thread) => thread.id === action.threadId)?.projectId;
  return projectId === undefined
    ? []
    : local
        .filter((thread) => thread.projectId === projectId)
        .map((thread) => ({ id: thread.id, title: thread.title }));
}

/** What this thread asked other people's agents, with status, reply and Cancel. */
function ThreadAgentRequestCards({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const state = useAtomValue(personalAgent.stateValueAtom);
  const cancel = useAtomCommand(personalAgent.cancel, { reportFailure: false });
  const requests = requestsForThread(state.outbox, { environmentId, threadId }).slice(0, 5);
  if (requests.length === 0) return null;
  return (
    <ul
      className="mx-auto flex w-full max-w-3xl flex-col gap-2 px-4 pb-2"
      aria-label="Requests to colleagues' agents"
    >
      {requests.map((request) => (
        <li key={request.id} className="rounded-lg border p-2 text-sm">
          <div className="flex flex-wrap items-center gap-1">
            <span className="text-muted-foreground">Asked</span>
            <Colleague userId={request.toAccountId} />
            <span className="text-muted-foreground">· {requesterStatusLabel(request)}</span>
            {request.status === "pending" ? (
              <Button
                className="ml-auto"
                size="xs"
                variant="ghost"
                onClick={() =>
                  void cancel(request.id).then((result) => {
                    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                      toastManager.add({
                        type: "error",
                        title: "Could not cancel the request",
                        description: errorMessage(squashAtomCommandFailure(result), "Try again."),
                      });
                    }
                  })
                }
              >
                Cancel
              </Button>
            ) : null}
          </div>
          <p className="line-clamp-2 text-muted-foreground">{request.body}</p>
          {request.reply !== null ? (
            <p className="mt-1 whitespace-pre-wrap">{request.reply.text}</p>
          ) : null}
          {request.status === "rejected" && request.decision?.reason ? (
            <p className="mt-1 text-muted-foreground">Reason: {request.decision.reason}</p>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Above a thread's composer: the approval cards in the personal agent thread, and the requests
 * any thread sent to colleagues' agents.
 */
export function ThreadPersonalAgentPanel({
  environmentId,
  threadId,
}: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const agent = useAtomValue(personalAgent.stateValueAtom).agent;
  const isAgentThread = agent?.environmentId === environmentId && agent.threadId === threadId;
  return (
    <>
      {isAgentThread ? (
        <div className="mx-auto max-h-[50vh] w-full max-w-3xl overflow-y-auto px-4 pb-2">
          <AgentApprovalList />
        </div>
      ) : null}
      <ThreadAgentRequestCards environmentId={environmentId} threadId={threadId} />
    </>
  );
}
