import type { EnvironmentId, ProjectId, VaultEntryId, VaultEntrySummary } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_VAULT_DRAFT,
  parseVaultDomains,
  toggleVaultScopeProject,
  vaultCreateInput,
  vaultDraftFromEntry,
  vaultDraftForRequest,
  vaultDraftIssue,
  vaultSaveFromRequest,
  vaultSaveFromRequestIssue,
  vaultPreviousVersionLabel,
  vaultSyncActions,
  vaultSyncShared,
  vaultSyncEnvironmentRows,
  vaultSyncPendingLabel,
  vaultSyncProblemMessage,
  vaultUpdateInput,
} from "./vault.ts";

const entry: VaultEntrySummary = {
  id: "entry-1" as VaultEntryId,
  name: "Staging admin",
  kind: "password",
  username: "admin",
  domains: ["staging.example.com"],
  scope: "global",
  version: 3,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-02T00:00:00.000Z",
};

describe("parseVaultDomains", () => {
  it("keeps the host of a pasted URL and drops duplicates", () => {
    expect(
      parseVaultDomains("https://Example.com:8443/login?next=1, example.com\napi.example.com"),
    ).toEqual(["example.com", "api.example.com"]);
  });
});

describe("vaultCreateInput", () => {
  it("names a password after its first domain when the name is left empty", () => {
    expect(
      vaultCreateInput({ ...EMPTY_VAULT_DRAFT, domains: "github.com, gitlab.com", value: "pw" }),
    ).toEqual({
      name: "github.com",
      kind: "password",
      domains: ["github.com", "gitlab.com"],
      scope: "global",
      value: "pw",
    });
  });

  it("needs a name for a token, which never carries a username", () => {
    const draft = {
      ...EMPTY_VAULT_DRAFT,
      kind: "token" as const,
      username: "ignored",
      domains: "github.com",
      value: "ghp_x",
    };
    expect(vaultDraftIssue(draft, "create")).toEqual({ kind: "incomplete" });
    const named = { ...draft, name: "GITHUB_TOKEN" };
    expect(vaultDraftIssue(named, "create")).toBeNull();
    expect(vaultCreateInput(named)).not.toHaveProperty("username");
  });

  it("requires a value only when creating", () => {
    const draft = { ...EMPTY_VAULT_DRAFT, name: "Note" };
    expect(vaultDraftIssue(draft, "create")).toEqual({ kind: "incomplete" });
    expect(vaultDraftIssue(draft, "edit")).toBeNull();
  });

  it("rejects a project scope with no project", () => {
    const scope = toggleVaultScopeProject(
      toggleVaultScopeProject("global", "p1" as ProjectId),
      "p1" as ProjectId,
    );
    expect(
      vaultDraftIssue({ ...EMPTY_VAULT_DRAFT, name: "x", value: "v", scope }, "create"),
    ).toEqual({ kind: "invalid", message: "Choose at least one project." });
  });
});

describe("vaultUpdateInput", () => {
  it("leaves the value out when the value input stays empty", () => {
    const draft = vaultDraftFromEntry(entry);
    expect(draft.value).toBe("");
    expect(vaultUpdateInput(entry, draft)).toBeNull();
    expect(vaultUpdateInput(entry, { ...draft, name: "Prod admin" })).toEqual({
      id: entry.id,
      name: "Prod admin",
    });
  });

  it("sends a typed value to replace the stored one", () => {
    expect(vaultUpdateInput(entry, { ...vaultDraftFromEntry(entry), value: "new" })).toEqual({
      id: entry.id,
      value: "new",
    });
  });

  it("clears the username with null", () => {
    expect(vaultUpdateInput(entry, { ...vaultDraftFromEntry(entry), username: "  " })).toEqual({
      id: entry.id,
      username: null,
    });
    expect(vaultUpdateInput(entry, { ...vaultDraftFromEntry(entry), kind: "token" })).toEqual({
      id: entry.id,
      kind: "token",
      username: null,
    });
  });

  it("ignores a reordered project scope", () => {
    const scoped = { ...entry, scope: { projects: ["a" as ProjectId, "b" as ProjectId] } };
    expect(
      vaultUpdateInput(scoped, {
        ...vaultDraftFromEntry(scoped),
        scope: { projects: ["b" as ProjectId, "a" as ProjectId] },
      }),
    ).toBeNull();
  });
});

describe("vaultSaveFromRequest", () => {
  it("keeps the request's suggestions and never carries a value", () => {
    const draft = vaultDraftForRequest({
      suggestedName: "Staging admin",
      suggestedDomains: ["staging.example.com"],
    });
    expect(vaultSaveFromRequestIssue(draft)).toBeNull();
    expect(vaultSaveFromRequest({ ...draft, value: "pw" })).toEqual({
      name: "Staging admin",
      kind: "password",
      domains: ["staging.example.com"],
      scope: "global",
    });
  });

  it("keeps a password's username and drops it for a token", () => {
    const draft = {
      ...vaultDraftForRequest({ suggestedDomains: ["github.com"] }),
      username: " alice ",
    };
    expect(vaultSaveFromRequest(draft).username).toBe("alice");
    expect(vaultSaveFromRequest({ ...draft, kind: "token", name: "GH" })).not.toHaveProperty(
      "username",
    );
  });

  it("falls back to the first domain for a password and asks for a name otherwise", () => {
    const draft = vaultDraftForRequest({ suggestedDomains: ["github.com"] });
    expect(vaultSaveFromRequest(draft).name).toBe("github.com");
    expect(vaultSaveFromRequestIssue({ ...draft, kind: "token" })).toEqual({
      kind: "incomplete",
    });
  });
});

describe("vaultSyncShared", () => {
  it("is on from joining until this machine leaves", () => {
    expect(vaultSyncShared("unavailable")).toBe(false);
    expect(vaultSyncShared("off")).toBe(false);
    expect(vaultSyncShared("waiting")).toBe(true);
    expect(vaultSyncShared("needs_rejoin")).toBe(true);
    expect(vaultSyncShared("on")).toBe(true);
  });
});

describe("vaultSyncActions", () => {
  it("offers a way back out of every joined state", () => {
    expect(vaultSyncActions("unavailable")).toEqual([]);
    expect(vaultSyncActions("off")).toEqual(["join"]);
    expect(vaultSyncActions("waiting")).toEqual(["leave"]);
    expect(vaultSyncActions("needs_rejoin")).toEqual(["join", "leave"]);
    expect(vaultSyncActions("on")).toEqual(["revoke", "rotate", "leave", "turnOff"]);
  });
});

describe("vaultSyncProblemMessage", () => {
  it("names the limit that was hit", () => {
    expect(vaultSyncProblemMessage({ reason: "quota_entry_size", entryName: "Big note" })).toBe(
      "Big note is over 64 KB and does not sync.",
    );
    expect(vaultSyncProblemMessage({ reason: "quota_entry_count" })).toContain("1000 entries");
    expect(vaultSyncProblemMessage({ reason: "quota_total_size" })).toContain("10 MB");
  });
});

describe("vaultSyncPendingLabel", () => {
  it("is hidden when nothing waits", () => {
    expect(vaultSyncPendingLabel(0)).toBeNull();
    expect(vaultSyncPendingLabel(1)).toBe("1 change waiting to upload");
    expect(vaultSyncPendingLabel(3)).toBe("3 changes waiting to upload");
  });
});

describe("vaultSyncEnvironmentRows", () => {
  const env = (id: string, isThis: boolean, hasKey = true) => ({
    environmentId: id as EnvironmentId,
    isThis,
    hasKey,
    enrolledAt: "2026-11-01T00:00:00.000Z",
  });
  const labels: Record<string, string> = { a: "Studio Mac", b: "Laptop" };

  it("lists this machine first and only lets others be revoked", () => {
    const rows = vaultSyncEnvironmentRows(
      { state: "on", environments: [env("c", false, false), env("a", false), env("b", true)] },
      (id) => labels[id],
    );
    expect(rows).toEqual([
      { environmentId: "b", label: "Laptop", detail: "This machine", canRevoke: false },
      {
        environmentId: "c",
        label: "Another machine",
        detail: "Waiting for its key",
        canRevoke: true,
      },
      { environmentId: "a", label: "Studio Mac", detail: undefined, canRevoke: true },
    ]);
  });

  it("revokes nothing while this machine is not fully joined", () => {
    const rows = vaultSyncEnvironmentRows(
      { state: "waiting", environments: [env("a", false), env("b", true)] },
      (id) => labels[id],
    );
    expect(rows.some((row) => row.canRevoke)).toBe(false);
  });
});

describe("vaultPreviousVersionLabel", () => {
  it("says what replaced the kept value", () => {
    const replacedAt = "2026-11-02T00:00:00.000Z";
    expect(vaultPreviousVersionLabel({ replacedAt, reason: "newer_edit" }, "2h ago")).toBe(
      "Replaced by a newer change 2h ago",
    );
    expect(vaultPreviousVersionLabel({ replacedAt, reason: "deleted" }, "2h ago")).toBe(
      "Deleted on another machine",
    );
  });
});
