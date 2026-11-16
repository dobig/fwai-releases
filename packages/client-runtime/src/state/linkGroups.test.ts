import {
  EnvironmentId,
  LinkChainId,
  LinkGroupId,
  NodeId,
  ThreadId,
  type LinkGroupsSnapshot,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { activeLinkTask, linkPeersForThread, linkTaskDisplayStatus } from "./linkGroups.ts";

const environmentId = EnvironmentId.make("environment-local");
const thread = (name: string) => ThreadId.make(`thread:${name}`);

describe("linkPeersForThread", () => {
  it("lists the other members of every group holding the thread", () => {
    const snapshot: LinkGroupsSnapshot = {
      environmentId,
      groups: [
        {
          linkId: LinkGroupId.make("link:b"),
          name: "Later",
          status: "paused",
          members: [
            { environmentId, threadId: thread("a"), purpose: "" },
            { environmentId, threadId: thread("c"), purpose: "owns c" },
          ],
          createdAt: "2026-11-11T10:05:00.000Z",
          updatedAt: "2026-11-11T10:05:00.000Z",
        },
        {
          linkId: LinkGroupId.make("link:a"),
          name: "Earlier",
          status: "active",
          members: [
            { environmentId, threadId: thread("a"), purpose: "" },
            { environmentId, threadId: thread("b"), purpose: "owns b" },
          ],
          createdAt: "2026-11-11T10:00:00.000Z",
          updatedAt: "2026-11-11T10:00:00.000Z",
        },
      ],
    };
    expect(linkPeersForThread(snapshot, thread("a")).map((row) => row.member.purpose)).toEqual([
      "owns b",
      "owns c",
    ]);
    expect(linkPeersForThread(snapshot, thread("z"))).toEqual([]);
  });
});

describe("link task state", () => {
  it("reads a stopped task as stopped whatever its run ended as", () => {
    const link = {
      linkId: LinkGroupId.make("link:a"),
      chainId: LinkChainId.make("chain:a"),
      hop: 1,
      parentTaskId: null,
    };
    expect(
      linkTaskDisplayStatus({
        status: "completed",
        result: "x",
        link: { ...link, stoppedBy: "the user" },
      }),
    ).toBe("stopped");
    expect(linkTaskDisplayStatus({ status: "pending", result: null, link })).toBe("queued");
  });

  it("finds the link task a live turn is handling", () => {
    const linkTask = {
      taskId: NodeId.make("task:1"),
      linkId: LinkGroupId.make("link:a"),
      chainId: LinkChainId.make("chain:a"),
      hop: 1,
      requester: { environmentId, threadId: thread("a") },
      sender: { threadTitle: "", projectTitle: "", purpose: "" },
    };
    expect(activeLinkTask([{ status: "completed", linkTask }, { status: "running" }])).toBeNull();
    expect(activeLinkTask([{ status: "running", linkTask }])).toEqual({
      requesterThreadId: thread("a"),
      taskId: NodeId.make("task:1"),
    });
  });
});
