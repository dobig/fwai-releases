import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { RelaySharedThread } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import {
  groupSharedThreads,
  sharedThreadRole,
  threadCapabilities,
  withoutRemovedThreads,
} from "./sharedThreads.ts";
import { describeShareStatus, shareQuickPicks, shareWaitsForOrgOwner } from "./shareTargets.ts";

const thread = (
  threadId: string,
  title: string,
  targetKind: RelaySharedThread["targetKind"],
  role: RelaySharedThread["role"] = "viewer",
): RelaySharedThread => ({
  environmentId: EnvironmentId.make("env_owner"),
  threadId: ThreadId.make(threadId),
  title,
  ownerSub: "usr_owner",
  role,
  targetKind,
  online: true,
});

describe("groupSharedThreads", () => {
  it("puts account shares under Shared with me and project or org shares under Team, by title", () => {
    const groups = groupSharedThreads([
      thread("t1", "Zeta", "project"),
      thread("t2", "Beta", "account"),
      thread("t3", "Alpha", "organization"),
      thread("t4", "Alpha", "account"),
    ]);
    expect(groups.sharedWithMe.map((entry) => entry.threadId)).toEqual(["t4", "t2"]);
    expect(groups.team.map((entry) => entry.threadId)).toEqual(["t3", "t1"]);
  });

  it("reads the account's role in a listed thread", () => {
    const threads = [thread("t1", "A", "project", "collaborator")];
    expect(sharedThreadRole(threads, EnvironmentId.make("env_owner"), "t1")).toBe("collaborator");
    expect(sharedThreadRole(threads, EnvironmentId.make("env_owner"), "t2")).toBeNull();
  });
});

describe("withoutRemovedThreads", () => {
  it("drops a thread its owner's environment removed, and only that one", () => {
    const threads = [thread("t1", "A", "project"), thread("t2", "B", "account")];
    const removed = new Map([[ThreadId.make("t1"), 42]]);
    expect(
      withoutRemovedThreads(threads, (environmentId) =>
        environmentId === "env_owner" ? removed : undefined,
      ).map((entry) => entry.threadId),
    ).toEqual(["t2"]);
    expect(withoutRemovedThreads(threads, () => undefined)).toBe(threads);
  });
});

describe("threadCapabilities", () => {
  it("keeps everything on the account's own environments", () => {
    expect(threadCapabilities({ sharedEnvironment: false, role: null })).toMatchObject({
      sendMessages: true,
      terminal: true,
      manageThread: true,
      share: true,
    });
  });

  it("lets a collaborator only send messages, and a viewer or unknown role only read", () => {
    const collaborator = threadCapabilities({ sharedEnvironment: true, role: "collaborator" });
    expect(collaborator.sendMessages).toBe(true);
    for (const key of [
      "respondToRuntime",
      "manageThread",
      "terminal",
      "files",
      "git",
      "settings",
      "projects",
      "share",
    ] as const) {
      expect(collaborator[key]).toBe(false);
    }
    expect(threadCapabilities({ sharedEnvironment: true, role: "viewer" }).sendMessages).toBe(
      false,
    );
    expect(threadCapabilities({ sharedEnvironment: true, role: null }).sendMessages).toBe(false);
  });
});

describe("share targets", () => {
  const organization = (role: "owner" | "member") => ({
    organization: { id: "org_1", name: "Acme", role },
    projects: [
      { id: "prj_mine", name: "Mine", member: true },
      { id: "prj_other", name: "Other", member: false },
      { id: "prj_legacy", name: "Legacy" },
    ],
  });

  it("offers an org owner every project and a member only their own", () => {
    expect(shareQuickPicks(organization("owner")).projects.map((p) => p.id)).toEqual([
      "prj_mine",
      "prj_other",
      "prj_legacy",
    ]);
    const member = shareQuickPicks(organization("member"));
    expect(member.projects.map((p) => p.id)).toEqual(["prj_mine", "prj_legacy"]);
    expect(member.organization).toEqual({ kind: "organization", id: "org_1", label: "Acme" });
    expect(shareQuickPicks(null)).toEqual({ projects: [], organization: null, role: null });
  });

  it("expects a member's whole-organization share to wait for an org owner", () => {
    expect(shareWaitsForOrgOwner("member", "organization")).toBe(true);
    expect(shareWaitsForOrgOwner("owner", "organization")).toBe(false);
    expect(shareWaitsForOrgOwner("member", "project")).toBe(false);
    expect(describeShareStatus({ status: "pending_approval" })).toBe(
      "Waiting for an organization owner",
    );
    expect(describeShareStatus({ status: "active" })).toBeNull();
    expect(describeShareStatus({ status: "proposed" })).toBe(
      "Proposed by an agent, waiting for you",
    );
  });
});
