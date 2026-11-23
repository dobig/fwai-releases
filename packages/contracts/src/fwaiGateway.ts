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
