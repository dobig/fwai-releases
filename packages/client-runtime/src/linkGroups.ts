import type { EnvironmentProject, EnvironmentThreadShell } from "./state/models.ts";
import {
  LINK_MAX_MEMBERS,
  type EnvironmentId,
  type LinkChainTask,
  type LinkGroup,
  type LinkGroupId,
  type LinkGroupsSnapshot,
  type LinkMemberInput,
  type LinkThreadRef,
  type NodeId,
  type OrchestrationV2RunStatus,
  type ThreadId,
  type ThreadShare,
  type ThreadShareGrantInput,
} from "@t3tools/contracts";
import type { RelaySharedThread } from "@t3tools/contracts/relay";

const isLinkableShell = (thread: EnvironmentThreadShell) =>
  thread.archivedAt === null &&
  thread.deletedAt === null &&
  thread.lineage.relationshipToParent !== "subagent";

const newestFirst = (left: EnvironmentThreadShell, right: EnvironmentThreadShell) =>
  right.updatedAt.localeCompare(left.updatedAt);

/** Threads the user can add to a group with the current one: same environment, top level, live. */
export function linkCandidateThreads(
  shells: ReadonlyArray<EnvironmentThreadShell>,
  environmentId: EnvironmentId,
  currentThreadId: ThreadId,
): ReadonlyArray<EnvironmentThreadShell> {
  return shells
    .filter(
      (thread) =>
        thread.environmentId === environmentId &&
        thread.id !== currentThreadId &&
        isLinkableShell(thread),
    )
    .sort(newestFirst);
}

export type LinkCandidate =
  | {
      readonly kind: "local";
      readonly ref: LinkThreadRef;
      readonly title: string;
      readonly project?: string;
    }
  | {
      readonly kind: "own-environment";
      readonly ref: LinkThreadRef;
      readonly title: string;
      readonly project?: string;
      readonly environmentLabel: string;
      readonly online: boolean;
    }
  | {
      readonly kind: "shared";
      readonly ref: LinkThreadRef;
      readonly title: string;
      readonly ownerSub: string;
      readonly online: boolean;
    };

const onlineFirst = (candidate: LinkCandidate) =>
  candidate.kind === "local" || candidate.online ? 0 : 1;

export const linkCandidateKey = (ref: LinkThreadRef) => `${ref.environmentId}:${ref.threadId}`;

/** An environment linked to the signed-in account, from the relay's environment list. */
export interface AccountEnvironment {
  readonly label: string;
  readonly online: boolean;
}

/**
 * Everything the current thread may link with (#21 "Who may link"): threads in its environment;
 * threads on the account's other linked environments, which need no share; and colleagues'
 * threads shared with the account as a collaborator, since a task to them needs that role.
 * Offline threads stay listed, after the online ones: the home retries until they are back.
 */
export function linkCandidates(input: {
  readonly current: LinkThreadRef;
  readonly shells: ReadonlyArray<EnvironmentThreadShell>;
  readonly accountEnvironments: ReadonlyMap<string, AccountEnvironment>;
  readonly sharedThreads: ReadonlyArray<RelaySharedThread>;
  /** Members of the group being added to, which are not offered again. */
  readonly exclude?: ReadonlyArray<LinkThreadRef>;
  /** Project titles, for the default purposes. */
  readonly projects?: ReadonlyArray<LinkProjectTitle>;
}): ReadonlyArray<LinkCandidate> {
  const { current, accountEnvironments } = input;
  const projectOf = projectTitleLookup(input.projects);
  const excluded = new Set((input.exclude ?? []).map(linkCandidateKey));
  excluded.add(linkCandidateKey(current));
  const local: LinkCandidate[] = [];
  const own: LinkCandidate[] = [];
  const currentIsLinked = accountEnvironments.has(current.environmentId);
  for (const thread of [...input.shells].sort(newestFirst)) {
    const ref = { environmentId: thread.environmentId, threadId: thread.id };
    if (excluded.has(linkCandidateKey(ref)) || !isLinkableShell(thread)) continue;
    const project = projectOf(thread);
    if (thread.environmentId === current.environmentId) {
      local.push({ kind: "local", ref, title: thread.title, ...(project ? { project } : {}) });
      continue;
    }
    const environment = accountEnvironments.get(thread.environmentId);
    if (!currentIsLinked || environment === undefined) continue;
    own.push({
      kind: "own-environment",
      ref,
      title: thread.title,
      ...(project ? { project } : {}),
      environmentLabel: environment.label,
      online: environment.online,
    });
  }
  const shared: LinkCandidate[] = input.sharedThreads
    .filter(
      (thread) =>
        thread.role === "collaborator" &&
        !accountEnvironments.has(thread.environmentId) &&
        !excluded.has(linkCandidateKey(thread)),
    )
    .map((thread) => ({
      kind: "shared" as const,
      ref: { environmentId: thread.environmentId, threadId: thread.threadId },
      title: thread.title,
      ownerSub: thread.ownerSub,
      online: thread.online,
    }))
    .sort(
      (left, right) =>
        onlineFirst(left) - onlineFirst(right) || left.title.localeCompare(right.title),
    );
  // Shells are newest first, and a stable sort keeps that order within online and offline.
  return [
    ...local,
    ...own.sort((left, right) => onlineFirst(left) - onlineFirst(right)),
    ...shared,
  ];
}

export interface LinkConfirmPlan {
  /** Reverse shares of the current thread, one per colleague not already holding one. */
  readonly grants: ReadonlyArray<ThreadShareGrantInput>;
  readonly members: ReadonlyArray<LinkMemberInput>;
}

/**
 * What confirming the picker does. A colleague's task to my thread acts for its owner, so linking
 * their thread shares mine back with them, under the approval setting the person chose here. An
 * existing share to them is kept as it is: granting again would be refused as a duplicate.
 */
export function linkConfirmPlan(input: {
  readonly current: LinkThreadRef;
  readonly currentShares: ReadonlyArray<ThreadShare>;
  readonly selected: ReadonlyArray<{ readonly candidate: LinkCandidate; readonly purpose: string }>;
  readonly requireApproval: boolean;
  /** The colleague's username, or null while it is unknown. */
  readonly ownerName: (ownerSub: string) => string | null;
}): LinkConfirmPlan {
  const grants: ThreadShareGrantInput[] = [];
  const granted = new Set(
    input.currentShares
      .filter((share) => share.target.kind === "account")
      .map((share) => share.target.id),
  );
  const members = input.selected.map(({ candidate, purpose }): LinkMemberInput => {
    const base = { threadId: candidate.ref.threadId, purpose: purpose.trim() };
    if (candidate.kind === "local") return base;
    const remote = { ...base, environmentId: candidate.ref.environmentId, title: candidate.title };
    if (candidate.kind === "own-environment") return remote;
    const owner = input.ownerName(candidate.ownerSub);
    if (!granted.has(candidate.ownerSub)) {
      granted.add(candidate.ownerSub);
      grants.push({
        threadId: input.current.threadId,
        target: { kind: "account", id: candidate.ownerSub, label: owner ?? candidate.ownerSub },
        role: "collaborator",
        requireApproval: input.requireApproval,
      });
    }
    return owner === null ? remote : { ...remote, owner };
  });
  return { grants, members };
}

export const LINK_NAME_MAX_LENGTH = 80;
export const LINK_PURPOSE_MAX_LENGTH = 300;

export type LinkProjectTitle = Pick<EnvironmentProject, "environmentId" | "id" | "title">;

const projectTitleLookup = (projects: ReadonlyArray<LinkProjectTitle> | undefined) => {
  const titles = new Map(
    (projects ?? []).map((project) => [`${project.environmentId}:${project.id}`, project.title]),
  );
  return (thread: Pick<EnvironmentThreadShell, "environmentId" | "projectId">) =>
    titles.get(`${thread.environmentId}:${thread.projectId}`);
};

/**
 * A member's purpose before the person edits it (#37): its project and thread title, so routing
 * has something to go on even when nobody writes one.
 */
export function defaultLinkPurpose(input: {
  readonly title: string | undefined;
  readonly project?: string | undefined;
}): string {
  const title = input.title?.trim() ?? "";
  const project = input.project?.trim() ?? "";
  const purpose =
    project === "" || project === title ? title : title === "" ? project : `${project}: ${title}`;
  return purpose.slice(0, LINK_PURPOSE_MAX_LENGTH);
}

/** The current thread's default purpose, from its shell and the known projects. */
export function defaultOwnLinkPurpose(
  thread: EnvironmentThreadShell | null | undefined,
  projects: ReadonlyArray<LinkProjectTitle>,
): string {
  return thread == null
    ? ""
    : defaultLinkPurpose({ title: thread.title, project: projectTitleLookup(projects)(thread) });
}

/** The picker's default name for a new group. */
export function defaultLinkGroupName(currentTitle: string | undefined): string {
  return `${currentTitle?.trim() || "Thread"} group`.slice(0, LINK_NAME_MAX_LENGTH);
}

/** Parsed from `/link`; null where the person gave nothing. */
export interface LinkCommandInput {
  /** The linked thread's purpose. */
  readonly purpose: string | null;
  /** The current thread's purpose. */
  readonly ownPurpose: string | null;
  readonly groupName: string | null;
}

export const NO_LINK_COMMAND_INPUT: LinkCommandInput = {
  purpose: null,
  ownPurpose: null,
  groupName: null,
};

type PlanGroup = Pick<LinkGroup, "linkId" | "name" | "members" | "createdAt">;

export type LinkCommandPlan =
  /** The two threads' groups are several: the person picks one, or a new group. */
  | { readonly kind: "choose" }
  /** Linking shares this thread back with a colleague: a person confirms that in the picker. */
  | { readonly kind: "confirm"; readonly linkId: LinkGroupId | null }
  /** Both threads are in the group already and no purpose was given. */
  | { readonly kind: "linked"; readonly name: string }
  | { readonly kind: "full"; readonly name: string }
  | {
      readonly kind: "create";
      readonly name: string;
      readonly ownPurpose: string;
      readonly plan: LinkConfirmPlan;
    }
  | {
      readonly kind: "add";
      readonly linkId: LinkGroupId;
      readonly name: string;
      /** Members to set: the threads joining, and members whose purpose changes. */
      readonly plan: LinkConfirmPlan;
      readonly addsCandidate: boolean;
      readonly addsCurrent: boolean;
    };

/** Where `/link` puts the threads: an existing group, or a new one. */
export type LinkGroupChoice = LinkGroupId | "new";

const isMemberOf = (group: Pick<LinkGroup, "members">, ref: LinkThreadRef) =>
  group.members.some((member) => linkCandidateKey(member) === linkCandidateKey(ref));

/** The groups holding either thread, oldest first: what `/link` may add to. */
export function linkGroupsOfEither<Group extends PlanGroup>(
  groups: ReadonlyArray<Group>,
  current: LinkThreadRef,
  candidate: LinkThreadRef,
): ReadonlyArray<Group> {
  return groups
    .filter((group) => isMemberOf(group, current) || isMemberOf(group, candidate))
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
}

const clip = (value: string | null, max: number) =>
  value === null ? null : value.trim().slice(0, max).trim() || null;

/**
 * What `/link <thread>` does (#21). Groups of either thread count, so `/link X` from A and
 * `/link A` from X meet in the same group; given purposes overwrite members' ones. A share back to
 * a colleague goes to the picker, because only a person may confirm it.
 */
export function linkCommandPlan(input: {
  readonly current: LinkThreadRef;
  readonly currentTitle: string | undefined;
  readonly currentPurpose?: string;
  readonly currentShares: ReadonlyArray<ThreadShare>;
  readonly candidate: LinkCandidate;
  /** The environment's groups. */
  readonly groups: ReadonlyArray<PlanGroup>;
  readonly ownerName: (ownerSub: string) => string | null;
  readonly command?: LinkCommandInput;
  /** The group the person chose when there were several. */
  readonly choice?: LinkGroupChoice;
}): LinkCommandPlan {
  const { choice, current, candidate } = input;
  const command = input.command ?? NO_LINK_COMMAND_INPUT;
  // The picker's inputs stop at these lengths too.
  const purpose = clip(command.purpose, LINK_PURPOSE_MAX_LENGTH);
  const ownPurpose = clip(command.ownPurpose, LINK_PURPOSE_MAX_LENGTH);
  const groupName = clip(command.groupName, LINK_NAME_MAX_LENGTH);
  const related = linkGroupsOfEither(input.groups, current, candidate.ref);
  const group =
    choice === "new"
      ? null
      : choice !== undefined
        ? related.find((entry) => entry.linkId === choice)
        : groupName !== null
          ? (related.find((entry) => entry.name.trim().toLowerCase() === groupName.toLowerCase()) ??
            null)
          : related.length > 1
            ? undefined
            : (related[0] ?? null);
  if (group === undefined) return { kind: "choose" };

  const currentIn = group !== null && isMemberOf(group, current);
  const candidateIn = group !== null && isMemberOf(group, candidate.ref);
  if (group !== null && currentIn && candidateIn && purpose === null && ownPurpose === null) {
    return { kind: "linked", name: group.name };
  }
  if (group !== null) {
    const joining = (currentIn ? 0 : 1) + (candidateIn ? 0 : 1);
    if (group.members.length + joining > LINK_MAX_MEMBERS)
      return { kind: "full", name: group.name };
  }
  const existingPurpose = group?.members.find(
    (member) => linkCandidateKey(member) === linkCandidateKey(candidate.ref),
  )?.purpose;
  const candidatePlan = linkConfirmPlan({
    current,
    currentShares: input.currentShares,
    selected: [{ candidate, purpose: purpose ?? existingPurpose ?? defaultLinkPurpose(candidate) }],
    requireApproval: true,
    ownerName: input.ownerName,
  });
  if (candidatePlan.grants.length > 0) return { kind: "confirm", linkId: group?.linkId ?? null };
  const currentPurpose =
    ownPurpose ?? input.currentPurpose ?? defaultLinkPurpose({ title: input.currentTitle });
  if (group === null) {
    return {
      kind: "create",
      name: groupName ?? defaultLinkGroupName(input.currentTitle),
      ownPurpose: currentPurpose,
      plan: candidatePlan,
    };
  }
  const setsCandidate = !candidateIn || purpose !== null;
  const setsCurrent = !currentIn || ownPurpose !== null;
  return {
    kind: "add",
    linkId: group.linkId,
    name: group.name,
    plan: {
      grants: [],
      members: [
        ...(setsCurrent ? [{ threadId: current.threadId, purpose: currentPurpose }] : []),
        ...(setsCandidate ? candidatePlan.members : []),
      ],
    },
    addsCandidate: !candidateIn,
    addsCurrent: !currentIn,
  };
}

/**
 * The groups `/link` offers when the two threads are in several, each with its other members'
 * names. A group that holds both threads (unless a purpose is being set), or has no room for the
 * missing one, is shown but cannot be chosen.
 */
export function linkGroupChoices(input: {
  readonly groups: ReadonlyArray<LinkGroup>;
  readonly current: LinkThreadRef;
  readonly candidate: LinkThreadRef;
  readonly setsPurpose: boolean;
  readonly memberTitle: (member: LinkGroup["members"][number]) => string;
}): ReadonlyArray<{
  readonly linkId: LinkGroupId;
  readonly name: string;
  readonly memberTitles: ReadonlyArray<string>;
  readonly unavailable: "member" | "full" | null;
}> {
  const { current, candidate } = input;
  const currentKey = linkCandidateKey(current);
  const candidateKey = linkCandidateKey(candidate);
  return linkGroupsOfEither(input.groups, current, candidate).map((group) => {
    const joining = (isMemberOf(group, current) ? 0 : 1) + (isMemberOf(group, candidate) ? 0 : 1);
    return {
      linkId: group.linkId,
      name: group.name,
      memberTitles: group.members
        .filter((member) => {
          const key = linkCandidateKey(member);
          return key !== currentKey && key !== candidateKey;
        })
        .map(input.memberTitle),
      unavailable:
        joining === 0 && !input.setsPurpose
          ? "member"
          : group.members.length + joining > LINK_MAX_MEMBERS
            ? "full"
            : null,
    };
  });
}

/** Distinct other threads that share a group with the thread. */
export function linkPeerThreadIds(
  snapshot: LinkGroupsSnapshot | null | undefined,
  threadId: ThreadId,
): ReadonlyArray<ThreadId> {
  if (snapshot == null) return [];
  const ids = new Set<ThreadId>();
  for (const group of snapshot.groups) {
    if (!group.members.some((member) => member.threadId === threadId)) continue;
    for (const member of group.members) {
      if (member.threadId !== threadId) ids.add(member.threadId);
    }
  }
  return [...ids];
}

export const isLiveLinkChainTask = (status: LinkChainTask["status"]): boolean =>
  status === "queued" || status === "running" || status === "waiting";

const LIVE_RUN_STATUSES = new Set<OrchestrationV2RunStatus>([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

export const isLiveLinkRun = (status: OrchestrationV2RunStatus): boolean =>
  LIVE_RUN_STATUSES.has(status);

interface LinkChainNode {
  readonly task: LinkChainTask;
  readonly depth: number;
}

/**
 * The chain as a depth-first list, each task under the one it was derived from. A task whose
 * parent is not in the chain starts its own root, so nothing is dropped.
 */
export function flattenLinkChain(
  tasks: ReadonlyArray<LinkChainTask>,
): ReadonlyArray<LinkChainNode> {
  const ids = new Set(tasks.map((task) => task.taskId));
  const childrenByParent = new Map<NodeId | null, LinkChainTask[]>();
  for (const task of [...tasks].sort((left, right) =>
    left.createdAt.localeCompare(right.createdAt),
  )) {
    const parent =
      task.parentTaskId !== null && ids.has(task.parentTaskId) ? task.parentTaskId : null;
    const siblings = childrenByParent.get(parent) ?? [];
    siblings.push(task);
    childrenByParent.set(parent, siblings);
  }
  const nodes: LinkChainNode[] = [];
  const visited = new Set<NodeId>();
  const visit = (task: LinkChainTask, depth: number) => {
    if (visited.has(task.taskId)) return;
    visited.add(task.taskId);
    nodes.push({ task, depth });
    for (const child of childrenByParent.get(task.taskId) ?? []) visit(child, depth + 1);
  };
  for (const root of childrenByParent.get(null) ?? []) visit(root, 0);
  return nodes;
}

const LINK_SUGGESTION_LIMIT = 12;

const normalizeQuery = (value: string) => value.trim().toLowerCase();

/**
 * What `/link <query>` offers: the picker's candidates whose title contains the query. An opening
 * bracket is where a picked title goes, not part of it.
 */
export function linkSuggestions(
  candidates: ReadonlyArray<LinkCandidate>,
  query: string,
): ReadonlyArray<LinkCandidate> {
  const normalized = normalizeQuery(query.trimStart().replace(/^\[/u, ""));
  return candidates
    .filter((candidate) => candidate.title.toLowerCase().includes(normalized))
    .slice(0, LINK_SUGGESTION_LIMIT);
}

/** What `/link <thread> group: <query>` offers: the two threads' groups whose name contains it. */
export function linkGroupSuggestions<Group extends Pick<LinkGroup, "name">>(
  groups: ReadonlyArray<Group>,
  query: string,
): ReadonlyArray<Group> {
  const normalized = normalizeQuery(query);
  return groups.filter((group) => group.name.toLowerCase().includes(normalized));
}
