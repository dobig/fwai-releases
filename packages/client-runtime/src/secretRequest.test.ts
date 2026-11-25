import { SecretRequestError, ThreadId, TurnItemId, type VaultEntryId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  secretRequestAnswerInput,
  secretRequestDisplay,
  secretRequestFailureMessage,
  secretRequestPrivacyNote,
  vaultApprovalPrompt,
  vaultRequestDisplay,
} from "./secretRequest.ts";

describe("secretRequestDisplay", () => {
  it("never offers the form for a request inherited from another thread", () => {
    expect(secretRequestDisplay({ secretStatus: "pending" }, "inherited")).toEqual({
      kind: "pending-elsewhere",
      label: "Waiting for an answer in the original thread",
    });
    expect(secretRequestDisplay({ secretStatus: "saved" }, "inherited")).toMatchObject({
      outcome: "saved",
    });
  });
});

describe("secretRequestPrivacyNote", () => {
  it("does not promise to hide a value that the agent's commands can read", () => {
    expect(secretRequestPrivacyNote({})).toBe("Stored securely, never shown to the agent");
    expect(secretRequestPrivacyNote({ delivery: "file" })).not.toContain("never shown");
  });
});

describe("secretRequestFailureMessage", () => {
  it("passes through server errors but hides anything that could echo the payload", () => {
    expect(
      secretRequestFailureMessage(new SecretRequestError({ reason: "already_answered" })),
    ).toBe("This secret request was already answered.");
    expect(secretRequestFailureMessage(new Error('Expected string, got "whsec_1"'))).toBe(
      "Could not answer the request. Try again.",
    );
    expect(secretRequestFailureMessage(undefined)).toBe("Could not answer the request. Try again.");
  });
});

describe("secretRequestAnswerInput", () => {
  const item = { id: TurnItemId.make("item-1"), threadId: ThreadId.make("thread-1") };

  it("answers with a vault entry and adds the project only when asked", () => {
    const entryId = "entry-1" as VaultEntryId;
    expect(secretRequestAnswerInput(item, { type: "vault", entryId })?.answer).toEqual({
      type: "vault",
      entryId,
    });
    expect(
      secretRequestAnswerInput(item, { type: "vault", entryId, alsoAllowProject: true })?.answer,
    ).toEqual({ type: "vault", entryId, alsoAllowProject: true });
  });

  it("trims a typed value and keeps it in the vault only when asked", () => {
    const saveToVault = { name: "x", kind: "token", domains: [], scope: "global" } as const;
    expect(secretRequestAnswerInput(item, { type: "save", secret: "  " })).toBeNull();
    expect(
      secretRequestAnswerInput(item, { type: "save", secret: " s ", saveToVault })?.answer,
    ).toEqual({ type: "save", secret: "s", saveToVault });
    expect(secretRequestAnswerInput(item, { type: "save", secret: "s" })?.answer).toEqual({
      type: "save",
      secret: "s",
    });
  });
});

describe("vaultRequestDisplay", () => {
  const vault = { entryId: "entry-1" as VaultEntryId, entryName: "Staging" as never };
  const approval = { ...vault, requestedByAccountId: "acct-bob" };

  it("leaves requests without a vault entry to the value form", () => {
    expect(vaultRequestDisplay({ secretStatus: "pending" }, "local")).toBeNull();
  });

  it("reports the owner's own use, and says when a command can read the value", () => {
    expect(vaultRequestDisplay({ secretStatus: "saved", vault }, "local")).toMatchObject({
      outcome: "used",
      label: "Used Staging",
    });
    expect(
      vaultRequestDisplay({ secretStatus: "saved", delivery: "file", vault }, "local"),
    ).toMatchObject({ outcome: "used", label: "A command can read Staging" });
  });

  it("asks the owner while another account's run waits, only where it was asked", () => {
    expect(vaultRequestDisplay({ secretStatus: "pending", vault: approval }, "local")).toEqual({
      kind: "approval-pending",
      entryName: "Staging",
      requestedByAccountId: "acct-bob",
    });
    expect(
      vaultRequestDisplay({ secretStatus: "pending", vault: approval }, "inherited")?.kind,
    ).toBe("pending-elsewhere");
  });

  it("shows how an approval ended", () => {
    const outcome = (secretStatus: "saved" | "declined" | "cancelled") => {
      const display = vaultRequestDisplay({ secretStatus, vault: approval }, "local");
      return display?.kind === "done" ? display.outcome : null;
    };
    expect([outcome("saved"), outcome("declined"), outcome("cancelled")]).toEqual([
      "used",
      "denied",
      "expired",
    ]);
  });
});

describe("vaultApprovalPrompt", () => {
  it("names the requester, entry and thread", () => {
    expect(
      vaultApprovalPrompt({ requesterName: "Bob", entryName: "Staging", threadTitle: "Deploy" }),
    ).toBe("Bob wants to use Staging in Deploy");
    expect(
      vaultApprovalPrompt({ requesterName: "Bob", entryName: "Staging", threadTitle: undefined }),
    ).toBe("Bob wants to use Staging");
  });
});
