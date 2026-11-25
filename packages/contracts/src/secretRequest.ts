import * as Schema from "effect/Schema";

import { ThreadId, TrimmedNonEmptyString, TurnItemId } from "./baseSchemas.ts";
import { VaultEntryId, VaultSaveFromRequest } from "./vault.ts";

/** Server stores the value under a one-use SecretRef; the thread learns only status. */
export const SecretRequestAnswerInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  answer: Schema.Union([
    Schema.Struct({
      type: Schema.Literal("save"),
      secret: TrimmedNonEmptyString,
      /** fwai: also keep the typed value as a vault entry. */
      saveToVault: Schema.optional(VaultSaveFromRequest),
    }),
    /** fwai: answer with a vault entry; `alsoAllowProject` adds this project to its scope. */
    Schema.Struct({
      type: Schema.Literal("vault"),
      entryId: VaultEntryId,
      alsoAllowProject: Schema.optional(Schema.Boolean),
    }),
    Schema.Struct({ type: Schema.Literal("decline") }),
  ]),
});
export type SecretRequestAnswerInput = typeof SecretRequestAnswerInput.Type;

/** fwai: the owner allows or denies one use of a vault entry by another account's run. */
export const SecretVaultApprovalInput = Schema.Struct({
  threadId: ThreadId,
  turnItemId: TurnItemId,
  decision: Schema.Literals(["allow", "deny"]),
});
export type SecretVaultApprovalInput = typeof SecretVaultApprovalInput.Type;

const SECRET_REQUEST_FAILURE_MESSAGES = {
  load_failed: "Could not load the secret request.",
  not_found: "This secret request no longer exists.",
  already_answered: "This secret request was already answered.",
  agent_stopped: "The agent that asked has stopped, so this secret can't be used.",
  store_failed: "Could not store the secret.",
  record_failed: "Saved the secret, but could not update the request.",
  invalid_ref: "That secretRef is not valid.",
  read_failed: "Could not read the secret.",
  ref_unavailable:
    "That secretRef was already used or does not exist. Ask the user again with request_secret.",
  ref_expired: "That secretRef expired. Ask the user again with request_secret.",
  consume_failed: "Could not use that secretRef. Try again.",
  vault_entry_unavailable: "That vault entry no longer exists or is not available here.",
  vault_save_failed: "Could not save the secret to the vault.",
  vault_name_taken: "Another vault entry visible to this project already has that name.",
  not_a_file_request:
    'The user did not save this secret for shell use. Ask again with request_secret and delivery: "file".',
} as const;

export const SecretRequestFailureReason = Schema.Literals(
  Object.keys(SECRET_REQUEST_FAILURE_MESSAGES) as Array<
    keyof typeof SECRET_REQUEST_FAILURE_MESSAGES
  >,
);
export type SecretRequestFailureReason = typeof SecretRequestFailureReason.Type;

export class SecretRequestError extends Schema.TaggedError<SecretRequestError>()(
  "SecretRequestError",
  {
    reason: SecretRequestFailureReason,
    cause: Schema.optionalKey(Schema.Defect()),
  },
) {
  override get message(): string {
    return SECRET_REQUEST_FAILURE_MESSAGES[this.reason];
  }
}
