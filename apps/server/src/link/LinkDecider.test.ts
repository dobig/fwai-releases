import {
  CommandId,
  EnvironmentId,
  LinkChainId,
  LinkGroupId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type LinkGroup,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { applyLinkEvent, decideLinkCommand, resolveCallerChain } from "./LinkDecider.ts";

const environmentId = EnvironmentId.make("environment-local");
const linkId = LinkGroupId.make("link:pair");
const at = (minute: number) =>
  DateTime.makeUnsafe(`2026-11-11T10:${String(minute).padStart(2, "0")}:00Z`);
const thread = (name: string) => ThreadId.make(`thread:${name}`);

describe("decideLinkCommand", () => {
  const group: LinkGroup = {
    linkId,
    name: "Pair",
    status: "active",
    members: [
      { environmentId, threadId: thread("a"), purpose: "" },
      { environmentId, threadId: thread("b"), purpose: "" },
    ],
    createdAt: "2026-11-11T10:00:00.000Z",
    updatedAt: "2026-11-11T10:00:00.000Z",
  };

  it("ends a group when it would be left with one member", () => {
    const decided = decideLinkCommand({
      command: {
        type: "link.member.remove",
        commandId: CommandId.make("command:remove"),
        linkId,
        member: { environmentId, threadId: thread("b") },
        reason: "thread-archived",
      },
      group,
      now: at(1),
    });
    const events = Result.getOrThrow(decided);
    expect(events.map((event) => event.type)).toEqual(["link.member-removed", "link.ended"]);
    expect(
      events.reduce<LinkGroup | null>(
        (next, event) => applyLinkEvent(next ?? undefined, event),
        group,
      ),
    ).toBeNull();
  });

  it("refuses a thread listed twice", () => {
    const decided = decideLinkCommand({
      command: {
        type: "link.create",
        commandId: CommandId.make("command:create"),
        linkId: LinkGroupId.make("link:dup"),
        name: "Dup",
        members: [group.members[0]!, group.members[0]!],
      },
      group: undefined,
      now: at(1),
    });
    expect(Result.isFailure(decided)).toBe(true);
  });
});

describe("resolveCallerChain", () => {
  const threadId = thread("a");
  const humanMessage = (minute: number) => ({
    id: MessageId.make(`message:${minute}`),
    role: "user" as const,
    createdBy: "user" as const,
    createdAt: at(minute),
  });
  const run = { id: RunId.make("run:now"), userMessageId: MessageId.make("message:now") };

  it("continues the chain of the task the run handles", () => {
    const chainId = LinkChainId.make("chain:upstream");
    expect(
      resolveCallerChain({
        threadId,
        run: {
          ...run,
          linkTask: {
            taskId: NodeId.make("task:in"),
            linkId,
            chainId,
            hop: 2,
            requester: { environmentId, threadId: thread("z") },
            sender: { threadTitle: "", projectTitle: "", purpose: "" },
          },
        },
        runs: [],
        subagents: [],
        messages: [humanMessage(5)],
      }),
    ).toEqual({ chainId, hop: 2, parentTaskId: NodeId.make("task:in") });
  });

  it("keeps a woken requester on its chain until a person speaks to it again", () => {
    const sent = {
      startedAt: at(2),
      link: {
        linkId,
        chainId: LinkChainId.make("chain:sent"),
        hop: 1,
        parentTaskId: null,
      },
    };
    const woken = resolveCallerChain({
      threadId,
      run,
      runs: [],
      subagents: [sent],
      messages: [humanMessage(1)],
    });
    expect(woken).toEqual({ chainId: sent.link.chainId, hop: 0, parentTaskId: null });

    const restarted = resolveCallerChain({
      threadId,
      run,
      runs: [],
      subagents: [sent],
      messages: [humanMessage(1), humanMessage(3)],
    });
    expect(restarted).toEqual({
      chainId: LinkChainId.make(`chain:${threadId}:message:3`),
      hop: 0,
      parentTaskId: null,
    });
  });
});
