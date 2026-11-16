import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { RelaySharedThread } from "@t3tools/contracts/relay";
import { describe, expect, it } from "vite-plus/test";

import { linkSuggestions, resolveShareTarget, shareSuggestions } from "./composerTeamCommands";
import { linkCandidates } from "./linkGroups.logic";

const member = (user_id: string, username: string, role: "owner" | "member" = "member") => ({
  user_id,
  username,
  role,
  project_ids: [],
});

const members = [
  member("usr_me", "bea"),
  member("usr_bob", "bob", "owner"),
  member("usr_bo", "Bo"),
  member("usr_cy", "cy"),
];

const picks = {
  projects: [
    { kind: "project" as const, id: "prj_web", label: "Web" },
    { kind: "project" as const, id: "prj_backoffice", label: "Back office" },
  ],
  organization: { kind: "organization" as const, id: "org_1", label: "Acme" },
  role: "member" as const,
};

describe("shareSuggestions", () => {
  it("offers colleagues by username prefix, then matching projects, then the organization last", () => {
    const suggestions = shareSuggestions({
      query: "b",
      members,
      picks,
      signedInUserId: "usr_me",
    });
    expect(
      suggestions.map((suggestion) => [suggestion.target.kind, suggestion.target.label]),
    ).toEqual([
      ["account", "bob"],
      ["account", "Bo"],
      ["project", "Back office"],
      ["organization", "Whole organization"],
    ]);
    // A member's whole-organization share waits for an owner.
    expect(suggestions.at(-1)?.description).toMatch(/owner approves/);
  });

  it("never offers the signed-in account", () => {
    const suggestions = shareSuggestions({ query: "", members, picks, signedInUserId: "usr_me" });
    expect(suggestions.some((suggestion) => suggestion.target.id === "usr_me")).toBe(false);
  });
});

describe("resolveShareTarget", () => {
  const resolve = (name: string) =>
    resolveShareTarget({ name, members, picks, signedInUserId: "usr_me" });

  it("matches a username or project exactly, case-insensitively", () => {
    expect(resolve("BOB")).toEqual({ kind: "account", id: "usr_bob", label: "bob" });
    expect(resolve("back office")).toEqual(picks.projects[1]);
  });

  it("matches the organization by its name or 'whole organization'", () => {
    expect(resolve("Whole organization")).toEqual(picks.organization);
    expect(resolve("acme")).toEqual(picks.organization);
  });

  it("is null for an unknown name, a prefix, an empty name, or myself", () => {
    expect(resolve("bobby")).toBeNull();
    expect(resolve("bo b")).toBeNull();
    expect(resolve("")).toBeNull();
    expect(resolve("bea")).toBeNull();
  });
});

const environmentId = EnvironmentId.make("env-1");
const otherEnvironmentId = EnvironmentId.make("env-2");

function shell(
  id: string,
  title: string,
  options: { readonly environmentId?: EnvironmentId; readonly subagent?: boolean } = {},
): EnvironmentThreadShell {
  return {
    environmentId: options.environmentId ?? environmentId,
    id: ThreadId.make(id),
    title,
    archivedAt: null,
    deletedAt: null,
    updatedAt: "2026-11-01T00:00:00.000Z",
    lineage: {
      parentThreadId: options.subagent ? ThreadId.make("parent") : null,
      relationshipToParent: options.subagent ? "subagent" : null,
    },
  } as EnvironmentThreadShell;
}

function shared(id: string, title: string, role: RelaySharedThread["role"]): RelaySharedThread {
  return {
    environmentId: EnvironmentId.make("env-bob"),
    threadId: ThreadId.make(id),
    title,
    ownerSub: "usr_bob",
    role,
    targetKind: "account",
    online: true,
  };
}

describe("linkSuggestions", () => {
  const candidates = linkCandidates({
    current: { environmentId, threadId: ThreadId.make("current") },
    shells: [
      shell("current", "Release notes"),
      shell("local", "Release checklist"),
      shell("child", "Release subtask", { subagent: true }),
      shell("server", "Release build", { environmentId: otherEnvironmentId }),
    ],
    accountEnvironments: new Map([
      [environmentId, { label: "Laptop", online: true }],
      [otherEnvironmentId, { label: "Server", online: true }],
    ]),
    sharedThreads: [
      shared("bobs", "Release review", "collaborator"),
      shared("bobs-view", "Release viewing", "viewer"),
    ],
  });

  it("matches titles across local, own-environment and collaborator threads", () => {
    expect(
      linkSuggestions(candidates, "release").map((candidate) => [
        candidate.kind,
        candidate.ref.threadId,
      ]),
    ).toEqual([
      ["local", "local"],
      ["own-environment", "server"],
      ["shared", "bobs"],
    ]);
  });

  it("leaves out the current thread, delegated children and view-only shares", () => {
    const ids = linkSuggestions(candidates, "").map((candidate) => candidate.ref.threadId);
    expect(ids).not.toContain("current");
    expect(ids).not.toContain("child");
    expect(ids).not.toContain("bobs-view");
  });

  it("matches a title being typed after the opening bracket", () => {
    expect(linkSuggestions(candidates, "[release REV").map((c) => c.ref.threadId)).toEqual([
      "bobs",
    ]);
  });
});
