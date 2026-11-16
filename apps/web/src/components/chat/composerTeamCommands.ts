import type { ShareQuickPicks } from "@t3tools/client-runtime/sharing/share-targets";
import type { FwaiGatewayOrganizationMember } from "@t3tools/shared/fwaiGateway";
import type { LinkGroup, ThreadShareTarget } from "@t3tools/contracts";

import type { LinkCandidate } from "./linkGroups.logic";

const MEMBER_SUGGESTION_LIMIT = 8;
const LINK_SUGGESTION_LIMIT = 12;

/** Names that pick the whole organization besides its own name. */
const ORGANIZATION_ALIASES = ["whole organization", "organization", "everyone"];

export interface ShareSuggestion {
  readonly target: ThreadShareTarget;
  readonly description: string;
}

const normalize = (value: string) => value.trim().toLowerCase();

/**
 * What `/share <query>` offers: colleagues whose username starts with the query, then the projects
 * this account may share with that have a word starting with it, then the whole organization,
 * always last.
 */
export function shareSuggestions(input: {
  readonly query: string;
  readonly members: ReadonlyArray<FwaiGatewayOrganizationMember>;
  readonly picks: ShareQuickPicks;
  readonly signedInUserId: string | null;
}): ReadonlyArray<ShareSuggestion> {
  const query = normalize(input.query);
  const members = input.members
    .filter(
      (member) =>
        member.user_id !== input.signedInUserId && member.username.toLowerCase().startsWith(query),
    )
    .slice(0, MEMBER_SUGGESTION_LIMIT)
    .map((member): ShareSuggestion => ({
      target: { kind: "account", id: member.user_id, label: member.username },
      description: member.role === "owner" ? "Organization owner" : "Colleague",
    }));
  const projects = input.picks.projects
    .filter((project) =>
      project.label
        .toLowerCase()
        .split(/\s+/)
        .some((word) => word.startsWith(query)),
    )
    .map((project): ShareSuggestion => ({ target: project, description: "Project" }));
  const organization = input.picks.organization;
  return [
    ...members,
    ...projects,
    ...(organization === null
      ? []
      : [
          {
            target: { ...organization, label: "Whole organization" },
            description:
              input.picks.role === "owner"
                ? `Everyone in ${organization.label}`
                : `Everyone in ${organization.label}, an owner approves`,
          },
        ]),
  ];
}

/**
 * The target a typed `/share <name>` means: a colleague by exact username, a project by exact
 * name, or the organization. Null when nothing matches.
 */
export function resolveShareTarget(input: {
  readonly name: string;
  readonly members: ReadonlyArray<FwaiGatewayOrganizationMember>;
  readonly picks: ShareQuickPicks;
  readonly signedInUserId: string | null;
}): ThreadShareTarget | null {
  const name = normalize(input.name);
  if (name === "") return null;
  const member = input.members.find(
    (candidate) =>
      candidate.user_id !== input.signedInUserId && candidate.username.toLowerCase() === name,
  );
  if (member !== undefined) {
    return { kind: "account", id: member.user_id, label: member.username };
  }
  const project = input.picks.projects.find((candidate) => candidate.label.toLowerCase() === name);
  if (project !== undefined) return project;
  const organization = input.picks.organization;
  if (
    organization !== null &&
    (ORGANIZATION_ALIASES.includes(name) || organization.label.toLowerCase() === name)
  ) {
    return organization;
  }
  return null;
}

/**
 * What `/link <query>` offers: the picker's candidates whose title contains the query. An opening
 * bracket is where a picked title goes, not part of it.
 */
export function linkSuggestions(
  candidates: ReadonlyArray<LinkCandidate>,
  query: string,
): ReadonlyArray<LinkCandidate> {
  const normalized = normalize(query.trimStart().replace(/^\[/u, ""));
  return candidates
    .filter((candidate) => candidate.title.toLowerCase().includes(normalized))
    .slice(0, LINK_SUGGESTION_LIMIT);
}

/** What `/link <thread> group: <query>` offers: the two threads' groups whose name contains it. */
export function linkGroupSuggestions<Group extends Pick<LinkGroup, "name">>(
  groups: ReadonlyArray<Group>,
  query: string,
): ReadonlyArray<Group> {
  const normalized = normalize(query);
  return groups.filter((group) => group.name.toLowerCase().includes(normalized));
}
