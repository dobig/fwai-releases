import type { ThreadShare, ThreadShareGrantInput, ThreadShareTarget } from "@t3tools/contracts";
import type {
  FwaiGatewayOrganizationMember,
  FwaiGatewayOrganizationResponse,
} from "@t3tools/shared/fwaiGateway";

export interface TeamMember {
  readonly userId: string;
  readonly username: string;
  readonly isOwner: boolean;
  readonly isSelf: boolean;
}

export interface TeamProject {
  readonly id: string;
  readonly name: string;
  readonly members: ReadonlyArray<TeamMember>;
}

export interface TeamStructure {
  readonly organization: { readonly id: string; readonly name: string };
  readonly role: "owner" | "member";
  readonly projects: ReadonlyArray<TeamProject>;
  /** Members in none of the listed projects. */
  readonly unassigned: ReadonlyArray<TeamMember>;
}

const byUsername = (left: TeamMember, right: TeamMember) =>
  left.username.localeCompare(right.username, undefined, { sensitivity: "base" });

/**
 * The organization as the team panel shows it: each project with its members, then everyone in
 * no listed project. The gateway decides which projects the caller sees (an owner gets every
 * project, a member only the ones they share), so this renders what it returns.
 */
export function groupTeamStructure(input: {
  readonly response: FwaiGatewayOrganizationResponse;
  readonly members: ReadonlyArray<FwaiGatewayOrganizationMember>;
  readonly signedInUserId: string | null;
}): TeamStructure | null {
  const organization = input.response.organization;
  if (organization === null) return null;
  const toMember = (member: FwaiGatewayOrganizationMember): TeamMember => ({
    userId: member.user_id,
    username: member.username,
    isOwner: member.role === "owner",
    isSelf: member.user_id === input.signedInUserId,
  });
  const projectIds = new Set(input.response.projects.map((project) => project.id));
  const projects = input.response.projects.map((project) => ({
    id: project.id,
    name: project.name,
    members: input.members
      .filter((member) => member.project_ids.includes(project.id))
      .map(toMember)
      .sort(byUsername),
  }));
  const unassigned = input.members
    .filter((member) => !member.project_ids.some((id) => projectIds.has(id)))
    .map(toMember)
    .sort(byUsername);
  return {
    organization: { id: organization.id, name: organization.name },
    role: organization.role,
    projects,
    unassigned,
  };
}

/** Why the current thread cannot be shared from a quick action, or null when it can. */
export function quickShareBlockReason(input: {
  readonly hasThread: boolean;
  /** The thread runs on a colleague's environment: this session only collaborates on it. */
  readonly isSharedEnvironment: boolean;
  /** `threadShare.grant` is allowed (the session holds `access:write`). */
  readonly canGrant: boolean;
}): string | null {
  if (!input.hasThread) return "Open a thread to share it.";
  if (input.isSharedEnvironment) return "Only the thread's owner can share it.";
  if (!input.canGrant) return "This session cannot share threads.";
  return null;
}

export function shareForTarget(
  shares: ReadonlyArray<ThreadShare>,
  target: Pick<ThreadShareTarget, "kind" | "id">,
): ThreadShare | undefined {
  return shares.find((share) => share.target.kind === target.kind && share.target.id === target.id);
}

/** A quick share: the share dialog's defaults, a collaborator whose actions the owner approves. */
export function quickShareGrant(
  threadId: ThreadShareGrantInput["threadId"],
  target: ThreadShareTarget,
): ThreadShareGrantInput {
  return { threadId, target, role: "collaborator", requireApproval: true };
}
