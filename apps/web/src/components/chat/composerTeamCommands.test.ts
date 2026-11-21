import { describe, expect, it } from "vite-plus/test";

import { resolveShareTarget, shareSuggestions } from "./composerTeamCommands";

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
