import { describe, expect, it } from "vite-plus/test";

import { createOrganizationStore } from "./organizationDirectory.ts";
import { groupTeamStructure, quickShareBlockReason } from "./team.ts";

const member = (
  user_id: string,
  username: string,
  project_ids: ReadonlyArray<string>,
  role: "owner" | "member" = "member",
) => ({ user_id, username, role, project_ids });

describe("groupTeamStructure", () => {
  it("groups members under each project and lists the rest apart, owners marked", () => {
    const structure = groupTeamStructure({
      response: {
        organization: { id: "org_1", name: "Acme", role: "owner" },
        projects: [
          { id: "prj_web", name: "Web" },
          { id: "prj_api", name: "API", member: false },
        ],
      },
      members: [
        member("usr_zoe", "zoe", ["prj_web", "prj_api"]),
        member("usr_ada", "Ada", ["prj_web"], "owner"),
        member("usr_bob", "bob", []),
        member("usr_cy", "cy", ["prj_hidden"]),
      ],
      signedInUserId: "usr_ada",
    });

    expect(structure?.organization).toEqual({ id: "org_1", name: "Acme" });
    expect(
      structure?.projects.map((project) => [
        project.name,
        project.members.map((entry) => entry.username),
      ]),
    ).toEqual([
      ["Web", ["Ada", "zoe"]],
      ["API", ["zoe"]],
    ]);
    expect(structure?.projects[0]?.members[0]).toMatchObject({ isOwner: true, isSelf: true });
    // A project the caller cannot see does not count as a project here.
    expect(structure?.unassigned.map((entry) => entry.username)).toEqual(["bob", "cy"]);
  });

  it("is null outside an organization", () => {
    expect(
      groupTeamStructure({
        response: { organization: null, projects: [] },
        members: [],
        signedInUserId: null,
      }),
    ).toBeNull();
  });
});

describe("quickShareBlockReason", () => {
  it("allows the owner's session with access:write", () => {
    expect(
      quickShareBlockReason({ hasThread: true, isSharedEnvironment: false, canGrant: true }),
    ).toBeNull();
  });

  it("blocks without a thread, in a collaborator session, and without the grant scope", () => {
    expect(
      quickShareBlockReason({ hasThread: false, isSharedEnvironment: false, canGrant: true }),
    ).toMatch(/Open a thread/);
    expect(
      quickShareBlockReason({ hasThread: true, isSharedEnvironment: true, canGrant: true }),
    ).toMatch(/owner/);
    expect(
      quickShareBlockReason({ hasThread: true, isSharedEnvironment: false, canGrant: false }),
    ).toMatch(/cannot share/);
  });
});

describe("createOrganizationStore", () => {
  it("reads once, shares the read, and reads again only when forced", async () => {
    let reads = 0;
    const store = createOrganizationStore(async () => {
      reads += 1;
      return { organization: { id: "org_1", name: "Acme", role: "member" }, projects: [] };
    });
    await Promise.all([store.load(), store.load()]);
    await store.load();
    expect(reads).toBe(1);
    expect(store.get().status).toBe("ready");
    await store.load({ force: true });
    expect(reads).toBe(2);
  });

  it("reports no organization, and retries a failure on the next load", async () => {
    const none = createOrganizationStore(async () => null);
    await none.load();
    expect(none.get()).toEqual({ status: "none" });

    let fail = true;
    const flaky = createOrganizationStore(async () => {
      if (fail) throw new Error("Could not reach the fwai gateway");
      return { organization: { id: "org_1", name: "Acme", role: "owner" }, projects: [] };
    });
    await flaky.load();
    expect(flaky.get()).toEqual({ status: "failed", message: "Could not reach the fwai gateway" });
    fail = false;
    await flaky.load();
    expect(flaky.get().status).toBe("ready");
  });
});
