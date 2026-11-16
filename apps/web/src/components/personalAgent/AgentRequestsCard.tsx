import { useAtomValue } from "@effect/atom-react";
import {
  agentRequestAwaitsOwner,
  isAgentRequestOpen,
  type AgentRequest,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { requesterStatusLabel } from "@t3tools/client-runtime/sharing/personal-agent";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useNavigate } from "@tanstack/react-router";
import { InboxIcon, XIcon } from "lucide-react";
import { useLayoutEffect, useState } from "react";
import { create } from "zustand";

import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";
import { selectThreadPanelOpen, useRightPanelStore } from "~/rightPanelStore";
import { personalAgent } from "~/state/personalAgent";
import { useAtomCommand } from "~/state/use-atom-command";
import { useChatCanvas } from "../chat/ChatCanvasContext";
import {
  THREAD_DETAILS_CARD_GAP,
  requestsCardMaxHeight,
  resolveThreadDetailsCardLayout,
} from "../chat/threadDetailsCardLayout";
import { Colleague, useIsTeamEdition, useOrganizationDirectory } from "../sharing/colleagues";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { ScrollArea } from "../ui/scroll-area";
import { toastManager } from "../ui/toast";
import { Toggle } from "../ui/toggle";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { AgentApprovalCard } from "./AgentRequestCards";

type Tab = "sent" | "received";

/** One card per window, whatever thread is open. */
export const useAgentRequestsCardStore = create<{
  readonly open: boolean;
  readonly tab: Tab;
  readonly toggle: (tab?: Tab) => void;
  readonly setOpen: (open: boolean) => void;
  readonly setTab: (tab: Tab) => void;
}>((set) => ({
  open: false,
  tab: "received",
  toggle: (tab) =>
    set((state) => ({
      open: !state.open || (tab !== undefined && tab !== state.tab),
      tab: tab ?? state.tab,
    })),
  setOpen: (open) => set({ open }),
  setTab: (tab) => set({ tab }),
}));

const errorMessage = (error: unknown) =>
  error instanceof Error && error.message ? error.message : "Try again.";

const byNewest = (left: AgentRequest, right: AgentRequest) =>
  right.createdAt.localeCompare(left.createdAt);

function ownerStatusLabel(request: AgentRequest): string {
  if (agentRequestAwaitsOwner(request)) return "Waiting for you";
  switch (request.status) {
    case "pending":
      return "Your agent is on it";
    case "accepted":
      return request.decision?.action.kind === "grant_access"
        ? "Access granted, agent is on it"
        : "Approved, running";
    case "replied":
      return "Answered";
    case "rejected":
      return "Declined";
    case "forwarded":
      return "Forwarded";
    case "expired":
      return "Expired";
    case "cancelled":
      return "Withdrawn";
  }
}

const shortTime = (iso: string) =>
  new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

/** Requests the open thread's composer header can reach: what is open and waiting. */
function useAgentRequestCounts() {
  const state = useAtomValue(personalAgent.stateValueAtom);
  return {
    waiting: state.inbox.filter(agentRequestAwaitsOwner).length,
    sentOpen: state.outbox.filter((request) => isAgentRequestOpen(request.status)).length,
  };
}

/** The header button that opens the requests card. */
export function AgentRequestsToggle() {
  // Personal agents are organization-only; the header reserves room for it in the team edition.
  const signedIn = useIsTeamEdition();
  const open = useAgentRequestsCardStore((state) => state.open);
  const toggle = useAgentRequestsCardStore((state) => state.toggle);
  const { waiting, sentOpen } = useAgentRequestCounts();
  if (!signedIn) return null;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="relative mr-1 flex shrink-0" />}>
        <Toggle
          className="shrink-0 [-webkit-app-region:no-drag]"
          pressed={open}
          onPressedChange={() => toggle()}
          aria-label="Requests"
          variant="ghost"
          size="sm"
        >
          <InboxIcon className="size-4" />
        </Toggle>
        {waiting > 0 ? (
          <span className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-full bg-info" />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">
        Requests{waiting > 0 ? ` · ${waiting} waiting for you` : ""}
        {sentOpen > 0 ? ` · ${sentOpen} open` : ""}
      </TooltipPopup>
    </Tooltip>
  );
}

/**
 * Requests to and from colleagues' agents (#22), at the bottom of the thread details column. It
 * reports its height so the details card gives that part of the column up, and beside an open
 * details card it takes at most `requestsCardMaxHeight`. Too narrow for the column, both float,
 * and only one of them is open at a time.
 */
export function AgentRequestsCard({ threadRef }: { readonly threadRef: ScopedThreadRef | null }) {
  const open = useAgentRequestsCardStore((state) => state.open);
  const signedIn = useOrganizationDirectory() !== null;
  const canvas = useChatCanvas();
  const detailsInline = useRightPanelStore((state) =>
    threadRef === null
      ? false
      : selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "inline"),
  );
  const detailsPopover = useRightPanelStore((state) =>
    threadRef === null
      ? false
      : selectThreadPanelOpen(state.threadPanelVisibilityByThreadKey, threadRef, "popover"),
  );
  const column = canvas
    ? resolveThreadDetailsCardLayout({
        container: canvas.container,
        lane: canvas.lane,
        frame: null,
        topInset: canvas.detailsCardTopInset,
      })
    : null;
  const visible = open && signedIn && (column !== null || !detailsPopover);
  const inline = visible && column !== null && canvas !== null;
  const report = canvas?.reportRequestsCard;
  const [element, setElement] = useState<HTMLElement | null>(null);
  // oxlint-disable-next-line t3code/react-effect-budget -- reports the rendered height to the canvas, which the details card reads to stay out of this card's space
  useLayoutEffect(() => {
    if (!report) return;
    if (!inline || element === null) {
      report(null);
      return;
    }
    const measure = () => report(element.offsetHeight);
    measure();
    const stop = observeResize(element, measure);
    return () => {
      stop();
      report(null);
    };
  }, [report, inline, element]);
  if (!visible) return null;
  if (!inline) {
    return (
      <aside
        aria-label="Requests"
        className="fixed right-3 bottom-3 z-40 flex max-h-[60dvh] w-80 max-w-[calc(100vw-1.5rem)]"
      >
        <RequestsCardBody />
      </aside>
    );
  }
  const maxHeight = detailsInline ? requestsCardMaxHeight(column.height) : column.height;
  return (
    <aside
      ref={setElement}
      aria-label="Requests"
      className="absolute z-20 flex"
      style={{
        right: column.right,
        bottom: THREAD_DETAILS_CARD_GAP,
        width: column.width,
        maxHeight,
      }}
    >
      <RequestsCardBody />
    </aside>
  );
}

function RequestsCardBody() {
  const tab = useAgentRequestsCardStore((state) => state.tab);
  const setTab = useAgentRequestsCardStore((state) => state.setTab);
  const setOpen = useAgentRequestsCardStore((state) => state.setOpen);
  const state = useAtomValue(personalAgent.stateValueAtom);
  const { waiting, sentOpen } = useAgentRequestCounts();
  const requests = (tab === "received" ? state.inbox : state.outbox).toSorted(byNewest);
  return (
    <div className="dropdown-glass isolate grid min-h-0 w-full grid-rows-[auto_minmax(0,1fr)] overflow-hidden rounded-2xl">
      <header className="flex items-center gap-1 border-b px-2 py-1.5">
        {(
          [
            ["received", "Received", waiting],
            ["sent", "Sent", sentOpen],
          ] as const
        ).map(([value, label, count]) => (
          <Button
            key={value}
            size="xs"
            variant={tab === value ? "secondary" : "ghost"}
            onClick={() => setTab(value)}
          >
            {label}
            {count > 0 ? (
              <Badge size="sm" variant="info">
                {count}
              </Badge>
            ) : null}
          </Button>
        ))}
        <Button
          className="ml-auto"
          size="icon-xs"
          variant="ghost"
          aria-label="Close requests"
          onClick={() => setOpen(false)}
        >
          <XIcon className="size-3.5" />
        </Button>
      </header>
      <ScrollArea scrollFade className="min-h-0">
        {requests.length === 0 ? (
          <p className="px-3 py-4 text-sm text-muted-foreground">
            {tab === "received" ? "Nothing received yet." : "Nothing sent yet."}
          </p>
        ) : (
          <ul className="flex flex-col">
            {requests.map((request) => (
              <RequestRow key={request.id} request={request} role={tab} />
            ))}
          </ul>
        )}
      </ScrollArea>
    </div>
  );
}

function RequestRow({ request, role }: { readonly request: AgentRequest; readonly role: Tab }) {
  const [expanded, setExpanded] = useState(role === "received" && agentRequestAwaitsOwner(request));
  const label = role === "received" ? ownerStatusLabel(request) : requesterStatusLabel(request);
  const highlight =
    role === "received" ? agentRequestAwaitsOwner(request) : isAgentRequestOpen(request.status);
  return (
    <li className="border-b last:border-b-0">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer flex-col gap-0.5 px-3 py-2 text-left text-sm hover:bg-accent/40"
      >
        <span className="flex items-center gap-1.5">
          <Colleague userId={role === "received" ? request.from.accountId : request.toAccountId} />
          <span className="ml-auto shrink-0 text-2xs text-muted-foreground">
            {shortTime(request.createdAt)}
          </span>
        </span>
        <span className={cn("line-clamp-2", expanded && "line-clamp-none whitespace-pre-wrap")}>
          {request.body}
        </span>
        <span className={cn("text-2xs", highlight ? "text-info" : "text-muted-foreground")}>
          {label}
        </span>
      </button>
      {expanded ? (
        role === "received" ? (
          <ReceivedDetails request={request} />
        ) : (
          <SentDetails request={request} />
        )
      ) : null}
    </li>
  );
}

function SentDetails({ request }: { readonly request: AgentRequest }) {
  const cancel = useAtomCommand(personalAgent.cancel, { reportFailure: false });
  const navigate = useNavigate();
  return (
    <div className="flex flex-col gap-2 px-3 pb-3 text-sm">
      {request.reply !== null ? (
        <blockquote className="whitespace-pre-wrap border-l-2 pl-2">
          {request.reply.text}
        </blockquote>
      ) : null}
      {request.status === "rejected" && request.decision?.reason ? (
        <p className="text-muted-foreground">{request.decision.reason}</p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button
          size="xs"
          variant="outline"
          onClick={() =>
            void navigate({
              to: "/$environmentId/$threadId",
              params: {
                environmentId: request.from.environmentId,
                threadId: request.from.threadId,
              },
            })
          }
        >
          Open thread
        </Button>
        {request.status === "pending" ? (
          <Button
            size="xs"
            variant="ghost"
            onClick={() =>
              void cancel(request.id).then((result) => {
                if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
                  toastManager.add({
                    type: "error",
                    title: "Could not cancel the request",
                    description: errorMessage(squashAtomCommandFailure(result)),
                  });
                }
              })
            }
          >
            Cancel request
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function ReceivedDetails({ request }: { readonly request: AgentRequest }) {
  const navigate = useNavigate();
  const agent = useAtomValue(personalAgent.stateValueAtom).agent;
  const openHandling = (environmentId: EnvironmentId) =>
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId: `personal-agent-req-${request.id}` },
    });
  return (
    <div className="flex flex-col gap-2 px-3 pb-3 text-sm">
      {agentRequestAwaitsOwner(request) ? (
        <AgentApprovalCard request={request} />
      ) : (
        <>
          {request.proposal ? (
            <p className="text-muted-foreground">{request.proposal.summary}</p>
          ) : null}
          {request.reply !== null ? (
            <blockquote className="whitespace-pre-wrap border-l-2 pl-2">
              {request.reply.text}
            </blockquote>
          ) : null}
          {request.decision ? (
            <p className="text-2xs text-muted-foreground">
              Decided {shortTime(request.decision.at)}
            </p>
          ) : null}
        </>
      )}
      {agent !== null ? (
        <Button size="xs" variant="outline" onClick={() => openHandling(agent.environmentId)}>
          How your agent handled it
        </Button>
      ) : null}
    </div>
  );
}
