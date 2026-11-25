import type {
  OrchestrationV2TurnItem,
  SecretRequestAnswerInput,
  VaultEntryId,
  VaultSaveFromRequest,
} from "@t3tools/contracts";

export type SecretRequestItem = Extract<
  OrchestrationV2TurnItem,
  { readonly type: "secret_request" }
>;

/** A `file` request lets the agent's commands read the value, so its card must not promise more. */
export const secretRequestPrivacyNote = (item: Pick<SecretRequestItem, "delivery">) =>
  item.delivery === "file"
    ? "Kept out of chat, in a private file this agent's commands can read for 24 hours"
    : "Stored securely, never shown to the agent";
export const SECRET_REQUEST_DEFAULT_PLACEHOLDER = "Paste the secret";

export type SecretRequestDisplay =
  | { readonly kind: "pending" }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "answered";
      readonly outcome: "saved" | "declined" | "ended";
      readonly label: string;
    };

const SAVED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "saved",
  label: "Saved securely and kept private",
};
const DECLINED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "declined",
  label: "Declined",
};
const ENDED_DISPLAY: SecretRequestDisplay = {
  kind: "answered",
  outcome: "ended",
  label: "Request ended",
};
const PENDING_DISPLAY: SecretRequestDisplay = { kind: "pending" };
const PENDING_ELSEWHERE_DISPLAY = {
  kind: "pending-elsewhere",
  label: "Waiting for an answer in the original thread",
} as const satisfies SecretRequestDisplay;

/**
 * `visibility` is the projected row's: a request inherited from another
 * thread (a fork) can only be answered where it was asked.
 */
export function secretRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus">,
  visibility: "local" | "inherited" | "synthetic",
): SecretRequestDisplay {
  switch (item.secretStatus) {
    case "pending":
      return visibility === "local" ? PENDING_DISPLAY : PENDING_ELSEWHERE_DISPLAY;
    case "saved":
      return SAVED_DISPLAY;
    case "declined":
      return DECLINED_DISPLAY;
    case "cancelled":
      return ENDED_DISPLAY;
  }
}

export type SecretRequestReply =
  | {
      readonly type: "save";
      readonly secret: string;
      readonly saveToVault?: VaultSaveFromRequest | undefined;
    }
  | { readonly type: "vault"; readonly entryId: VaultEntryId; readonly alsoAllowProject?: boolean }
  | { readonly type: "decline" };

export function secretRequestAnswerInput(
  item: Pick<SecretRequestItem, "id" | "threadId">,
  reply: SecretRequestReply,
): SecretRequestAnswerInput | null {
  const request = { threadId: item.threadId, turnItemId: item.id };
  switch (reply.type) {
    case "decline":
      return { ...request, answer: { type: "decline" } };
    case "vault":
      return {
        ...request,
        answer: {
          type: "vault",
          entryId: reply.entryId,
          ...(reply.alsoAllowProject ? { alsoAllowProject: true } : {}),
        },
      };
    case "save": {
      const secret = reply.secret.trim();
      if (secret.length === 0) return null;
      return {
        ...request,
        answer: {
          type: "save",
          secret,
          ...(reply.saveToVault ? { saveToVault: reply.saveToVault } : {}),
        },
      };
    }
  }
}

const USER_FACING_FAILURE_TAGS = new Set(["SecretRequestError", "EnvironmentAuthorizationError"]);

/**
 * Only known server errors pass their message through: anything else (transport or encoding
 * failures) gets the generic copy, so the typed value can never surface in the UI.
 */
export function secretRequestFailureMessage(failure: unknown): string {
  if (
    typeof failure === "object" &&
    failure !== null &&
    "_tag" in failure &&
    typeof failure._tag === "string" &&
    USER_FACING_FAILURE_TAGS.has(failure._tag) &&
    "message" in failure &&
    typeof failure.message === "string" &&
    failure.message.trim().length > 0
  ) {
    return failure.message;
  }
  return "Could not answer the request. Try again.";
}

export type VaultRequestDisplay =
  | {
      readonly kind: "approval-pending";
      readonly entryName: string;
      readonly requestedByAccountId: string;
    }
  | { readonly kind: "pending-elsewhere"; readonly label: string }
  | {
      readonly kind: "done";
      readonly outcome: "used" | "denied" | "expired";
      readonly label: string;
    };

/**
 * A request naming a vault entry is never answered with a value: the owner's run used it, or a
 * run acting for `requestedByAccountId` waits for the owner to allow it. Null for other requests.
 */
export function vaultRequestDisplay(
  item: Pick<SecretRequestItem, "secretStatus" | "delivery" | "vault">,
  visibility: "local" | "inherited" | "synthetic",
): VaultRequestDisplay | null {
  const { vault } = item;
  if (vault === undefined) return null;
  const name = vault.entryName;
  if (item.secretStatus === "pending" && vault.requestedByAccountId !== undefined) {
    return visibility === "local"
      ? {
          kind: "approval-pending",
          entryName: name,
          requestedByAccountId: vault.requestedByAccountId,
        }
      : PENDING_ELSEWHERE_DISPLAY;
  }
  switch (item.secretStatus) {
    case "declined":
      return { kind: "done", outcome: "denied", label: `Denied use of ${name}` };
    case "cancelled":
      return { kind: "done", outcome: "expired", label: `Request to use ${name} expired` };
    default:
      return {
        kind: "done",
        outcome: "used",
        label: item.delivery === "file" ? `A command can read ${name}` : `Used ${name}`,
      };
  }
}

export const vaultApprovalPrompt = (input: {
  readonly requesterName: string;
  readonly entryName: string;
  readonly threadTitle: string | undefined;
}) =>
  `${input.requesterName} wants to use ${input.entryName}${input.threadTitle ? ` in ${input.threadTitle}` : ""}`;
