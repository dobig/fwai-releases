import type { EnvironmentThreadShell } from "./state/models.ts";
import {
  EnvironmentId,
  LINK_MAX_MEMBERS,
  type LinkChainTask,
  type LinkGroup,
  LinkGroupId,
  type LinkMember,
  NodeId,
  ProjectId,
  ThreadId,
  ThreadShareId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { RelaySharedThread } from "@t3tools/contracts/relay";

import {
  defaultLinkPurpose,
  flattenLinkChain,
  linkCandidates,
  linkCandidateThreads,
  type LinkCommandInput,
  linkCommandPlan,
  linkConfirmPlan,
  type LinkGroupChoice,
  linkGroupChoices,
  linkPeerThreadIds,
  linkSuggestions,
  NO_LINK_COMMAND_INPUT,
} from "./linkGroups.ts";

const environmentId = EnvironmentId.make("env-1");
const otherEnvironmentId = EnvironmentId.make("env-2");

function shell(
  id: string,
  overrides: Partial<
    Pick<EnvironmentThreadShell, "environmentId" | "archivedAt" | "updatedAt" | "title">
  > & {
    readonly subagent?: boolean;
  } = {},
): EnvironmentThreadShell {
  return {
    environmentId: overrides.environmentId ?? environmentId,
    id: ThreadId.make(id),
    title: overrides.title ?? id,
    archivedAt: overrides.archivedAt ?? null,
    deletedAt: null,
    updatedAt: overrides.updatedAt ?? "2026-11-01T00:00:00.000Z",
    projectId: ProjectId.make(`project-${id}`),
    lineage: {
      parentThreadId: overrides.subagent ? ThreadId.make("parent") : null,
      relationshipToParent: overrides.subagent ? "subagent" : null,
    },
  } as EnvironmentThreadShell;
}

function task(id: string, parent: string | null, createdAt: string): LinkChainTask {
  const ref = { environmentId, threadId: ThreadId.make(`thread-${id}`) };
  return {
    taskId: NodeId.make(id),
    linkId: LinkGroupId.make("link-1"),
    hop: 1,
    parentTaskId: parent === null ? null : NodeId.make(parent),
    requester: ref,
    assignee: ref,
    prompt: id,
    status: "running",
    stoppedBy: null,
    createdAt,
  } as LinkChainTask;
}

describe("linkCandidateThreads", () => {
  it("offers only live top-level threads of the same environment, newest first", () => {
    const candidates = linkCandidateThreads(
      [
        shell("current"),
        shell("older", { updatedAt: "2026-11-01T00:00:00.000Z" }),
        shell("newer", { updatedAt: "2026-11-02T00:00:00.000Z" }),
        shell("archived", { archivedAt: "2026-11-03T00:00:00.000Z" }),
        shell("child", { subagent: true }),
        shell("remote", { environmentId: otherEnvironmentId }),
      ],
      environmentId,
      ThreadId.make("current"),
    );
    expect(candidates.map((thread) => thread.id)).toEqual(["newer", "older"]);
  });
});

describe("linkPeerThreadIds", () => {
  it("lists each peer once across groups and leaves out unrelated groups", () => {
    const member = (threadId: string) => ({
      environmentId,
      threadId: ThreadId.make(threadId),
      purpose: "",
    });
    const group = (linkId: string, threads: ReadonlyArray<string>) => ({
      linkId: LinkGroupId.make(linkId),
      name: linkId,
      status: "active" as const,
      members: threads.map(member),
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
    });
    expect(
      linkPeerThreadIds(
        {
          environmentId,
          groups: [group("a", ["me", "x", "y"]), group("b", ["me", "x"]), group("c", ["z", "w"])],
        },
        ThreadId.make("me"),
      ),
    ).toEqual(["x", "y"]);
  });
});

describe("flattenLinkChain", () => {
  it("nests derived tasks under their parent in creation order", () => {
    const nodes = flattenLinkChain([
      task("child-b", "root", "2026-11-01T00:00:03.000Z"),
      task("root", null, "2026-11-01T00:00:00.000Z"),
      task("grandchild", "child-a", "2026-11-01T00:00:04.000Z"),
      task("child-a", "root", "2026-11-01T00:00:01.000Z"),
    ]);
    expect(nodes.map((node) => [node.task.taskId, node.depth])).toEqual([
      ["root", 0],
      ["child-a", 1],
      ["grandchild", 2],
      ["child-b", 1],
    ]);
  });

  it("keeps a task whose parent is outside the chain as a root", () => {
    const nodes = flattenLinkChain([task("orphan", "missing", "2026-11-01T00:00:00.000Z")]);
    expect(nodes.map((node) => [node.task.taskId, node.depth])).toEqual([["orphan", 0]]);
  });
});

const colleagueEnvironmentId = EnvironmentId.make("env-bob");

function sharedThread(
  id: string,
  overrides: Partial<Pick<RelaySharedThread, "role" | "online" | "environmentId">> = {},
): RelaySharedThread {
  return {
    environmentId: overrides.environmentId ?? colleagueEnvironmentId,
    threadId: ThreadId.make(id),
    title: id,
    ownerSub: "user-bob",
    role: overrides.role ?? "collaborator",
    targetKind: "account",
    online: overrides.online ?? true,
  };
}

const current = { environmentId, threadId: ThreadId.make("current") };
const accountEnvironments = new Map([
  [environmentId, { label: "Laptop", online: true }],
  [otherEnvironmentId, { label: "Server", online: false }],
]);

describe("linkCandidates", () => {
  it("offers my other linked environments without a share, and collaborator shares", () => {
    const candidates = linkCandidates({
      current,
      shells: [
        shell("current"),
        shell("here"),
        shell("on-server", { environmentId: otherEnvironmentId }),
        shell("unlinked", { environmentId: EnvironmentId.make("env-ssh") }),
      ],
      accountEnvironments,
      sharedThreads: [
        sharedThread("bobs"),
        sharedThread("bobs-view-only", { role: "viewer" }),
        // The relay lists my own environment's thread when someone shares it back to me.
        sharedThread("mine-again", { environmentId: otherEnvironmentId }),
      ],
    });
    expect(candidates.map((candidate) => [candidate.kind, candidate.ref.threadId])).toEqual([
      ["local", "here"],
      ["own-environment", "on-server"],
      ["shared", "bobs"],
    ]);
  });

  it("offers other environments only when the current one is linked to the account", () => {
    const candidates = linkCandidates({
      current,
      shells: [shell("on-server", { environmentId: otherEnvironmentId })],
      accountEnvironments: new Map([[otherEnvironmentId, { label: "Server", online: true }]]),
      sharedThreads: [],
    });
    expect(candidates).toEqual([]);
  });

  it("keeps offline threads, after the online ones, marked offline", () => {
    const candidates = linkCandidates({
      current,
      shells: [],
      accountEnvironments,
      sharedThreads: [sharedThread("a-offline", { online: false }), sharedThread("b-online")],
    });
    expect(
      candidates.map((candidate) => [
        candidate.ref.threadId,
        candidate.kind === "local" ? true : candidate.online,
      ]),
    ).toEqual([
      ["b-online", true],
      ["a-offline", false],
    ]);
  });

  it("leaves out members of the group being added to", () => {
    const candidates = linkCandidates({
      current,
      shells: [shell("here"), shell("member")],
      accountEnvironments,
      sharedThreads: [sharedThread("bobs")],
      exclude: [
        { environmentId, threadId: ThreadId.make("member") },
        { environmentId: colleagueEnvironmentId, threadId: ThreadId.make("bobs") },
      ],
    });
    expect(candidates.map((candidate) => candidate.ref.threadId)).toEqual(["here"]);
  });
});

describe("linkConfirmPlan", () => {
  const [here, onServer, bobs, bobsOther] = linkCandidates({
    current,
    shells: [shell("here"), shell("on-server", { environmentId: otherEnvironmentId })],
    accountEnvironments,
    sharedThreads: [sharedThread("bobs"), sharedThread("bobs-other")],
  });

  it("shares my thread back once per colleague, with the approval the person chose", () => {
    const plan = linkConfirmPlan({
      current,
      currentShares: [],
      selected: [
        { candidate: here!, purpose: " local " },
        { candidate: onServer!, purpose: "server" },
        { candidate: bobs!, purpose: "bob" },
        { candidate: bobsOther!, purpose: "bob again" },
      ],
      requireApproval: false,
      ownerName: () => "bob",
    });
    expect(plan.grants).toEqual([
      {
        threadId: current.threadId,
        target: { kind: "account", id: "user-bob", label: "bob" },
        role: "collaborator",
        requireApproval: false,
      },
    ]);
    expect(plan.members).toEqual([
      { threadId: "here", purpose: "local" },
      {
        threadId: "on-server",
        purpose: "server",
        environmentId: otherEnvironmentId,
        title: "on-server",
      },
      {
        threadId: "bobs",
        purpose: "bob",
        environmentId: colleagueEnvironmentId,
        title: "bobs",
        owner: "bob",
      },
      {
        threadId: "bobs-other",
        purpose: "bob again",
        environmentId: colleagueEnvironmentId,
        title: "bobs-other",
        owner: "bob",
      },
    ]);
  });

  it("asks for no share for my own threads, or for a colleague who already has one", () => {
    const plan = linkConfirmPlan({
      current,
      currentShares: [
        {
          id: ThreadShareId.make("share-1"),
          target: { kind: "account", id: "user-bob", label: "bob" },
          role: "collaborator",
          requireApproval: true,
          status: "active",
          grantedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      selected: [
        { candidate: onServer!, purpose: "" },
        { candidate: bobs!, purpose: "" },
      ],
      requireApproval: true,
      ownerName: () => null,
    });
    expect(plan.grants).toEqual([]);
    expect(plan.members.at(-1)).not.toHaveProperty("owner");
  });
});

const groupMember = (threadId: string, purpose = "", title?: string): LinkMember => ({
  environmentId,
  threadId: ThreadId.make(threadId),
  purpose,
  ...(title === undefined ? {} : { title }),
});
const linkGroup = (
  linkId: string,
  name: string,
  members: ReadonlyArray<LinkMember>,
  createdAt = "2026-11-01T00:00:00.000Z",
) =>
  ({
    linkId: LinkGroupId.make(linkId),
    name,
    status: "active",
    members,
    createdAt,
    updatedAt: createdAt,
  }) as LinkGroup;

describe("linkCommandPlan", () => {
  const candidateFor = (id: string, from = current, title = "Scopes endpoint") =>
    linkCandidates({
      current: from,
      shells: id === "bobs" ? [] : [shell(id, { title })],
      accountEnvironments,
      sharedThreads: [sharedThread("bobs")],
      projects: [{ environmentId, id: ProjectId.make(`project-${id}`), title: "llm_gateway" }],
    }).find((candidate) => candidate.ref.threadId === id)!;
  const self = groupMember(current.threadId, "Releases");
  const here = groupMember("here", "Scopes");
  const planFor = (
    groups: ReadonlyArray<LinkGroup>,
    options: {
      readonly command?: Partial<LinkCommandInput>;
      readonly choice?: LinkGroupChoice;
      readonly candidate?: string;
      readonly from?: typeof current;
    } = {},
  ) =>
    linkCommandPlan({
      current: options.from ?? current,
      currentTitle: "Release",
      currentPurpose: "fwai_code: Release",
      currentShares: [],
      candidate: candidateFor(options.candidate ?? "here", options.from),
      groups,
      ownerName: () => null,
      command: { ...NO_LINK_COMMAND_INPUT, ...options.command },
      ...(options.choice === undefined ? {} : { choice: options.choice }),
    });

  it("creates a group of the two threads, with purposes from their projects and titles", () => {
    expect(planFor([])).toEqual({
      kind: "create",
      name: "Release group",
      ownPurpose: "fwai_code: Release",
      plan: {
        grants: [],
        members: [{ threadId: "here", purpose: "llm_gateway: Scopes endpoint" }],
      },
    });
    // A colleague's thread has no project here; its title stands in.
    expect(defaultLinkPurpose(candidateFor("bobs"))).toBe("bobs");
  });

  it("creates a group with the given name and purposes when neither thread is in one", () => {
    expect(
      planFor([], {
        command: {
          purpose: "负责所有数学计算",
          ownPurpose: "负责户型和面积测量",
          groupName: "装修",
        },
      }),
    ).toEqual({
      kind: "create",
      name: "装修",
      ownPurpose: "负责户型和面积测量",
      plan: { grants: [], members: [{ threadId: "here", purpose: "负责所有数学计算" }] },
    });
  });

  it("adds the thread to the current thread's only group without asking", () => {
    const group = linkGroup("link-1", "Release group", [self, groupMember("api")]);
    expect(planFor([group])).toEqual({
      kind: "add",
      linkId: "link-1",
      name: "Release group",
      plan: {
        grants: [],
        members: [{ threadId: "here", purpose: "llm_gateway: Scopes endpoint" }],
      },
      addsCandidate: true,
      addsCurrent: false,
    });
  });

  it("adds the current thread to the other thread's only group, so either side meets there", () => {
    const group = linkGroup("link-1", "Scopes", [here, groupMember("api")]);
    expect(planFor([group])).toEqual({
      kind: "add",
      linkId: "link-1",
      name: "Scopes",
      plan: { grants: [], members: [{ threadId: "current", purpose: "fwai_code: Release" }] },
      addsCandidate: false,
      addsCurrent: true,
    });
    // The same two threads the other way round land in the same group.
    const fromHere = planFor([group], {
      from: { environmentId, threadId: ThreadId.make("here") },
      candidate: "current",
    });
    expect(fromHere).toMatchObject({ kind: "add", linkId: "link-1", addsCandidate: true });
  });

  it("ignores unrelated groups when deciding", () => {
    const unrelated = linkGroup("link-9", "Other", [groupMember("x"), groupMember("y")]);
    expect(planFor([unrelated]).kind).toBe("create");
    const group = linkGroup("link-1", "Scopes", [here, groupMember("api")]);
    expect(planFor([unrelated, group])).toMatchObject({ kind: "add", linkId: "link-1" });
  });

  it("asks which group when the two threads' groups are several", () => {
    const mine = linkGroup("link-1", "Release", [self, groupMember("api")]);
    const theirs = linkGroup("link-2", "Scopes", [here, groupMember("db")]);
    expect(planFor([mine, theirs])).toEqual({ kind: "choose" });
    expect(planFor([mine, theirs], { choice: theirs.linkId })).toMatchObject({
      kind: "add",
      linkId: "link-2",
      addsCurrent: true,
    });
    expect(planFor([mine, theirs], { choice: "new" })).toMatchObject({ kind: "create" });
    // A dissolved choice asks again.
    expect(planFor([mine, theirs], { choice: LinkGroupId.make("link-gone") })).toEqual({
      kind: "choose",
    });
  });

  it("uses the group named in group: when either thread is in it, by name in any case", () => {
    const mine = linkGroup("link-1", "Release", [self, groupMember("api")]);
    const theirs = linkGroup("link-2", "装修", [here, groupMember("db")]);
    expect(planFor([mine, theirs], { command: { groupName: "release" } })).toMatchObject({
      kind: "add",
      linkId: "link-1",
      addsCandidate: true,
    });
    expect(planFor([mine, theirs], { command: { groupName: "装修" } })).toMatchObject({
      kind: "add",
      linkId: "link-2",
      addsCurrent: true,
    });
  });

  it("creates a new group for a group: name neither thread's groups have", () => {
    const mine = linkGroup("link-1", "Release", [self, groupMember("api")]);
    const unrelated = linkGroup("link-9", "Design", [groupMember("x"), groupMember("y")]);
    expect(planFor([mine, unrelated], { command: { groupName: "Design" } })).toMatchObject({
      kind: "create",
      name: "Design",
    });
  });

  it("sets given purposes on members already there, and keeps the others", () => {
    const group = linkGroup("link-1", "Release", [self, here]);
    expect(planFor([group])).toEqual({ kind: "linked", name: "Release" });
    expect(planFor([group], { command: { purpose: "只做计算" } })).toMatchObject({
      kind: "add",
      plan: { members: [{ threadId: "here", purpose: "只做计算" }] },
      addsCandidate: false,
      addsCurrent: false,
    });
    expect(planFor([group], { command: { ownPurpose: "负责户型设计" } })).toMatchObject({
      plan: { members: [{ threadId: "current", purpose: "负责户型设计" }] },
    });
    // The thread joining gets its given purpose; the member keeps its own.
    const theirs = linkGroup("link-2", "Scopes", [here, groupMember("db")]);
    expect(planFor([theirs], { command: { ownPurpose: "负责户型设计" } })).toMatchObject({
      plan: { members: [{ threadId: "current", purpose: "负责户型设计" }] },
    });
  });

  it("cuts purposes and names to the picker's limits", () => {
    const plan = planFor([], {
      command: { purpose: "p".repeat(400), groupName: "g".repeat(100) },
    });
    expect(plan).toMatchObject({ kind: "create", name: "g".repeat(80) });
    expect(plan.kind === "create" && plan.plan.members[0]?.purpose.length).toBe(300);
  });

  it("refuses a full group, naming it", () => {
    const full = linkGroup(
      "link-1",
      "Big",
      Array.from({ length: LINK_MAX_MEMBERS }, (_, index) =>
        index === 0 ? self : groupMember(`m${index}`),
      ),
    );
    expect(planFor([full])).toEqual({ kind: "full", name: "Big" });
  });

  it("hands a colleague's thread to the picker with the group it would join", () => {
    const mine = linkGroup("link-1", "Release", [self, groupMember("api")]);
    expect(planFor([mine], { candidate: "bobs" })).toEqual({ kind: "confirm", linkId: "link-1" });
    expect(planFor([], { candidate: "bobs" })).toEqual({ kind: "confirm", linkId: null });
  });

  it("links a colleague's thread directly once my thread is already shared with them", () => {
    const plan = linkCommandPlan({
      current,
      currentTitle: "Release",
      currentShares: [
        {
          id: ThreadShareId.make("share-1"),
          target: { kind: "account", id: "user-bob", label: "bob" },
          role: "collaborator",
          requireApproval: true,
          status: "active",
          grantedAt: "2026-11-01T00:00:00.000Z",
        },
      ],
      candidate: candidateFor("bobs"),
      groups: [],
      ownerName: () => "bob",
    });
    expect(plan.kind).toBe("create");
  });
});

describe("linkGroupChoices", () => {
  it("lists both threads' groups and marks those that cannot take the missing thread", () => {
    const self = groupMember(current.threadId);
    const here = groupMember("here");
    const groups = [
      linkGroup("link-1", "Release", [self, groupMember("api", "", "API")]),
      linkGroup("link-2", "Docs", [self, here]),
      linkGroup(
        "link-3",
        "Big",
        Array.from({ length: LINK_MAX_MEMBERS }, (_, index) =>
          index === 0 ? self : groupMember(`m${index}`),
        ),
      ),
      linkGroup("link-4", "Scopes", [here, groupMember("db", "", "DB")]),
      linkGroup("link-5", "Unrelated", [groupMember("x"), groupMember("y")]),
    ];
    const choicesFor = (setsPurpose: boolean) =>
      linkGroupChoices({
        groups,
        current,
        candidate: { environmentId, threadId: ThreadId.make("here") },
        setsPurpose,
        memberTitle: (entry) => entry.title ?? entry.threadId,
      });
    expect(choicesFor(false).map(({ name, unavailable }) => ({ name, unavailable }))).toEqual([
      { name: "Release", unavailable: null },
      { name: "Docs", unavailable: "member" },
      { name: "Big", unavailable: "full" },
      { name: "Scopes", unavailable: null },
    ]);
    expect(choicesFor(false)[3]?.memberTitles).toEqual(["DB"]);
    // Setting a purpose makes the group holding both a valid choice.
    expect(choicesFor(true)[1]?.unavailable).toBeNull();
  });
});

describe("linkSuggestions", () => {
  const candidates = linkCandidates({
    current: { environmentId, threadId: ThreadId.make("current") },
    shells: [
      shell("current", { title: "Release notes" }),
      shell("local", { title: "Release checklist" }),
      shell("child", { title: "Release subtask", subagent: true }),
      shell("server", { title: "Release build", environmentId: otherEnvironmentId }),
    ],
    accountEnvironments: new Map([
      [environmentId, { label: "Laptop", online: true }],
      [otherEnvironmentId, { label: "Server", online: true }],
    ]),
    sharedThreads: [
      { ...sharedThread("bobs"), title: "Release review" },
      { ...sharedThread("bobs-view", { role: "viewer" }), title: "Release viewing" },
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
