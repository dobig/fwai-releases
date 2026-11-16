import type { ThreadShare, ThreadShareTarget, ThreadShareTargetKind } from "@t3tools/contracts";
import type { FwaiGatewayOrganizationResponse } from "@t3tools/shared/fwaiGateway";

export type OrganizationRole = "owner" | "member";

export interface ShareQuickPicks {
  /** Projects this account may share with: every project for an org owner, their own for a member. */
  readonly projects: ReadonlyArray<ThreadShareTarget & { readonly kind: "project" }>;
  /** The whole organization. A member's share is a request an org owner approves (#20 decision 2). */
  readonly organization: (ThreadShareTarget & { readonly kind: "organization" }) | null;
  readonly role: OrganizationRole | null;
}

/** The share dialog's quick picks from `GET /v1/me/organization`. */
export function shareQuickPicks(response: FwaiGatewayOrganizationResponse | null): ShareQuickPicks {
  const organization = response?.organization ?? null;
  if (organization === null) return { projects: [], organization: null, role: null };
  const projects = response?.projects ?? [];
  return {
    projects: projects
      // `member` is absent on gateways that list only the caller's own projects.
      .filter((project) => organization.role === "owner" || project.member !== false)
      .map((project) => ({ kind: "project" as const, id: project.id, label: project.name })),
    organization: { kind: "organization", id: organization.id, label: organization.name },
    role: organization.role,
  };
}

/**
 * A member's whole-organization share grants nothing until an org owner approves it. The relay
 * decides; this only tells the dialog what to expect.
 */
export function shareWaitsForOrgOwner(
  role: OrganizationRole | null,
  kind: ThreadShareTargetKind,
): boolean {
  return kind === "organization" && role !== "owner";
}

/** A short note for a share that does not grant access yet, or null when it is active. */
export function describeShareStatus(share: Pick<ThreadShare, "status">): string | null {
  switch (share.status) {
    case "active":
      return null;
    case "proposed":
      return "Proposed by an agent, waiting for you";
    case "pending_approval":
      return "Waiting for an organization owner";
    case "rejected":
      return "Rejected";
  }
}

export function describeShareRole(share: Pick<ThreadShare, "role" | "requireApproval">): string {
  if (share.role === "viewer") return "Can view";
  return share.requireApproval ? "Can send messages, you approve actions" : "Can send messages";
}
