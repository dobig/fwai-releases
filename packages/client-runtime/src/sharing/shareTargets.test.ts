import type { ThreadShare } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { describeShareDetail, shareTargetLabel } from "./shareTargets.ts";

const share = (overrides: Partial<ThreadShare> = {}): ThreadShare =>
  ({
    id: "shr_1",
    target: { kind: "account", id: "usr_ada", label: "ada" },
    role: "collaborator",
    requireApproval: true,
    status: "active",
    grantedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  }) as ThreadShare;

const link = (mode: "single" | "multi", extra: { closedAt?: string } = {}) =>
  share({
    target: { kind: "link", id: "hash", label: "" },
    role: "viewer",
    link: { mode, expiresAt: "2026-01-08T00:00:00.000Z", ...extra },
  } as Partial<ThreadShare>);

const NOW = "2026-01-02T00:00:00.000Z";
const formatDate = (expiresAt: string) => expiresAt.slice(0, 10);

describe("shareTargetLabel", () => {
  it("names each kind of target", () => {
    expect(shareTargetLabel(share())).toBe("ada");
    expect(shareTargetLabel(share({ target: { kind: "account", id: "usr_x", label: "" } }))).toBe(
      "Someone",
    );
    expect(shareTargetLabel(share({ target: { kind: "project", id: "p", label: "Web" } }))).toBe(
      "Project Web",
    );
    expect(
      shareTargetLabel(share({ target: { kind: "organization", id: "o", label: "Acme" } })),
    ).toBe("Everyone in Acme");
    expect(shareTargetLabel(link("single"))).toBe("Invite link for one person");
    expect(shareTargetLabel(link("multi"))).toBe("Invite link for anyone");
  });
});

describe("describeShareDetail", () => {
  it("joins the access, link state and pending status", () => {
    expect(describeShareDetail(share(), NOW, formatDate)).toBe(
      "Can send messages, you approve actions",
    );
    expect(
      describeShareDetail(
        share({ status: "pending_approval", viaShareId: "shr_link" } as Partial<ThreadShare>),
        NOW,
        formatDate,
      ),
    ).toBe("Can send messages, you approve actions · via link · Waiting for an organization owner");
  });

  it("says when a link was used, expired, or when it expires", () => {
    expect(describeShareDetail(link("multi"), NOW, formatDate)).toBe(
      "Can view · Expires 2026-01-08",
    );
    expect(
      describeShareDetail(
        link("single", { closedAt: "2026-01-01T12:00:00.000Z" }),
        NOW,
        formatDate,
      ),
    ).toBe("Can view · Used");
    expect(describeShareDetail(link("multi"), "2026-02-01T00:00:00.000Z", formatDate)).toBe(
      "Can view · Expired",
    );
  });
});
