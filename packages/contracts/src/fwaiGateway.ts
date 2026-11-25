import * as Schema from "effect/Schema";

import { IsoDateTime } from "./baseSchemas.ts";

/**
 * The environment's own fwai Gateway session, used to route Claude and Codex through the
 * gateway. It is separate from the client's account session: the environment runs the CLIs.
 */
export const FwaiGatewayConnectionState = Schema.Union([
  Schema.Struct({ status: Schema.Literal("signed-out") }),
  Schema.Struct({
    status: Schema.Literal("pending"),
    userCode: Schema.String,
    verificationUrl: Schema.String,
    expiresAt: IsoDateTime,
  }),
  Schema.Struct({
    status: Schema.Literal("connected"),
    username: Schema.NullOr(Schema.String),
  }),
  Schema.Struct({ status: Schema.Literal("error"), message: Schema.String }),
]);
export type FwaiGatewayConnectionState = typeof FwaiGatewayConnectionState.Type;

/** The code the requesting client approves with its own signed-in account. */
export const FwaiGatewayConnectResult = Schema.Struct({ userCode: Schema.String });
export type FwaiGatewayConnectResult = typeof FwaiGatewayConnectResult.Type;

export class FwaiGatewayRpcError extends Schema.TaggedError<FwaiGatewayRpcError>()(
  "FwaiGatewayRpcError",
  { message: Schema.String },
) {}

/**
 * The environment's attestation key a signed-in client registers with the gateway under its own
 * account (llm_gateway#760). Only the public key leaves the environment.
 */
export const FwaiAttestationRegistration = Schema.Struct({
  environmentId: Schema.String,
  /** Raw Ed25519 public key, base64url without padding. */
  publicKey: Schema.String,
  name: Schema.String,
});
export type FwaiAttestationRegistration = typeof FwaiAttestationRegistration.Type;

/** What the gateway answered when the client registered `publicKey`; a rejected key is replaced. */
export const FwaiAttestationReport = Schema.Struct({
  publicKey: Schema.String,
  outcome: Schema.Union([
    Schema.Struct({ status: Schema.Literal("registered"), expiresAt: IsoDateTime }),
    // Revoked, expired, or registered to another account or environment.
    Schema.Struct({ status: Schema.Literal("key-rejected") }),
  ]),
});
export type FwaiAttestationReport = typeof FwaiAttestationReport.Type;
