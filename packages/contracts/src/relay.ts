import * as Context from "effect/Context";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiMiddleware from "effect/http-api/HttpApiMiddleware";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";
import * as HttpApiSecurity from "effect/http-api/HttpApiSecurity";
import * as OpenApi from "effect/http-api/OpenApi";

import {
  DpopFailureReason,
  EnvironmentId,
  NodeId,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  ThreadShareId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AuthAccountOrganization } from "./auth.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  LINK_MAX_MEMBERS,
  LinkActivityEntry,
  LinkChainId,
  LinkGroupId,
  LinkGroupStatus,
  LinkMemberRemovalReason,
  LinkName,
  LinkPurpose,
  LinkTaskSender,
  LinkThreadRef,
} from "./linkGroups.ts";
import {
  AGENT_REPLY_MAX_LENGTH,
  AGENT_REQUEST_BODY_MAX_LENGTH,
  AgentAccountId,
  AgentDecision,
  AgentEnvelopeKind,
  AgentEnvironmentRecord,
  AgentExecution,
  AgentProposal,
  AgentProposedAction,
  AgentRequest,
  AgentRequestId,
} from "./personalAgent.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import {
  THREAD_SHARE_LIMIT,
  ThreadShare,
  ThreadShareRole,
  ThreadShareStatus,
  ThreadShareTargetKind,
} from "./threadShare.ts";

export const RelayAgentAwarenessPlatform = Schema.Literals(["ios", "android"]);
export type RelayAgentAwarenessPlatform = typeof RelayAgentAwarenessPlatform.Type;

export const RelayAgentAwarenessPhase = Schema.Literals([
  "starting",
  "running",
  "waiting_for_approval",
  "waiting_for_input",
  "completed",
  "failed",
  "stale",
]);
export type RelayAgentAwarenessPhase = typeof RelayAgentAwarenessPhase.Type;

export const RelayAgentAwarenessPreferences = Schema.Struct({
  liveActivitiesEnabled: Schema.Boolean,
  notificationsEnabled: Schema.Boolean,
  notifyOnApproval: Schema.Boolean,
  notifyOnInput: Schema.Boolean,
  notifyOnCompletion: Schema.Boolean,
  notifyOnFailure: Schema.Boolean,
});
export type RelayAgentAwarenessPreferences = typeof RelayAgentAwarenessPreferences.Type;

export const RelayApnsEnvironment = Schema.Literals(["sandbox", "production"]);
export type RelayApnsEnvironment = typeof RelayApnsEnvironment.Type;

export const RelayDeviceRegistrationRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  iosMajorVersion: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(18))),
  androidApiLevel: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(24))),
  appVersion: Schema.optional(TrimmedNonEmptyString),
  // APNs topic must match the variant's bundle id; development-signed builds use sandbox tokens.
  bundleId: Schema.optional(TrimmedNonEmptyString),
  apsEnvironment: Schema.optional(RelayApnsEnvironment),
  pushToken: Schema.optional(TrimmedNonEmptyString),
  pushToStartToken: Schema.optional(TrimmedNonEmptyString),
  preferences: RelayAgentAwarenessPreferences,
}).check(
  Schema.makeFilter((device) =>
    device.platform === "ios"
      ? device.iosMajorVersion !== undefined
      : device.androidApiLevel !== undefined &&
        device.iosMajorVersion === undefined &&
        device.apsEnvironment === undefined &&
        device.pushToStartToken === undefined,
  ),
);
export type RelayDeviceRegistrationRequest = typeof RelayDeviceRegistrationRequest.Type;

export const RelayClientDeviceRecord = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  platform: RelayAgentAwarenessPlatform,
  iosMajorVersion: Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(18))),
  androidApiLevel: Schema.optional(Schema.NullOr(Schema.Int)),
  appVersion: Schema.NullOr(TrimmedNonEmptyString),
  notifications: Schema.Struct({
    enabled: Schema.Boolean,
    notifyOnApproval: Schema.Boolean,
    notifyOnInput: Schema.Boolean,
    notifyOnCompletion: Schema.Boolean,
    notifyOnFailure: Schema.Boolean,
  }),
  liveActivities: Schema.Struct({
    enabled: Schema.Boolean,
  }),
  updatedAt: TrimmedNonEmptyString,
});
export type RelayClientDeviceRecord = typeof RelayClientDeviceRecord.Type;

export const RelayListDevicesResponse = Schema.Struct({
  devices: Schema.Array(RelayClientDeviceRecord),
});
export type RelayListDevicesResponse = typeof RelayListDevicesResponse.Type;

// Installed clients decode v1 as iOS-only. Keep that response contract frozen.
export const RelayListDevicesResponseV1 = Schema.Struct({
  devices: Schema.Array(
    Schema.Struct({
      ...RelayClientDeviceRecord.fields,
      platform: Schema.Literal("ios"),
      iosMajorVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(18)),
    }),
  ),
});

export const RelayLiveActivityRegistrationRequest = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  activityPushToken: TrimmedNonEmptyString,
});
export type RelayLiveActivityRegistrationRequest = typeof RelayLiveActivityRegistrationRequest.Type;

export const RelayDeviceUnregistrationParams = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
});
export type RelayDeviceUnregistrationParams = typeof RelayDeviceUnregistrationParams.Type;

export const RelayAgentActivityState = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  phase: RelayAgentAwarenessPhase,
  headline: TrimmedNonEmptyString,
  detail: Schema.optional(TrimmedNonEmptyString),
  modelTitle: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
});
export type RelayAgentActivityState = typeof RelayAgentActivityState.Type;

export const RelayAgentActivityAggregateRow = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  projectTitle: TrimmedNonEmptyString,
  threadTitle: TrimmedNonEmptyString,
  modelTitle: TrimmedNonEmptyString,
  phase: RelayAgentAwarenessPhase,
  status: TrimmedNonEmptyString,
  updatedAt: TrimmedNonEmptyString,
  deepLink: TrimmedNonEmptyString,
});
export type RelayAgentActivityAggregateRow = typeof RelayAgentActivityAggregateRow.Type;

export const RelayAgentActivityAggregateState = Schema.Struct({
  title: TrimmedNonEmptyString,
  subtitle: TrimmedNonEmptyString,
  activeCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: TrimmedNonEmptyString,
  activities: Schema.Array(RelayAgentActivityAggregateRow),
});
export type RelayAgentActivityAggregateState = typeof RelayAgentActivityAggregateState.Type;

export const RelayManagedEndpointProviderKind = Schema.Literals([
  "manual",
  "cloudflare_tunnel",
  "t3_relay",
]);
export type RelayManagedEndpointProviderKind = typeof RelayManagedEndpointProviderKind.Type;

export const RelayManagedEndpoint = Schema.Struct({
  httpBaseUrl: TrimmedNonEmptyString,
  wsBaseUrl: TrimmedNonEmptyString,
  providerKind: RelayManagedEndpointProviderKind,
});
export type RelayManagedEndpoint = typeof RelayManagedEndpoint.Type;

export const RelayManagedEndpointOrigin = Schema.Struct({
  localHttpHost: TrimmedNonEmptyString,
  localHttpPort: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(65_535),
  ),
});
export type RelayManagedEndpointOrigin = typeof RelayManagedEndpointOrigin.Type;

export const RelayManagedEndpointRuntimeConfig = Schema.Struct({
  providerKind: RelayManagedEndpointProviderKind,
  connectorToken: TrimmedNonEmptyString,
  tunnelId: Schema.optional(TrimmedNonEmptyString),
  tunnelName: Schema.optional(TrimmedNonEmptyString),
});
export type RelayManagedEndpointRuntimeConfig = typeof RelayManagedEndpointRuntimeConfig.Type;

export const RelayManagedEndpointRecoveryRequest = Schema.Struct({
  cloudUserId: TrimmedNonEmptyString,
  origin: RelayManagedEndpointOrigin,
  proof: TrimmedNonEmptyString,
});
export type RelayManagedEndpointRecoveryRequest = typeof RelayManagedEndpointRecoveryRequest.Type;

export const RelayManagedEndpointRecoveryRegistrationRequest = Schema.Struct({
  cloudUserId: TrimmedNonEmptyString,
  tunnelId: TrimmedNonEmptyString,
  origin: RelayManagedEndpointOrigin,
  proof: TrimmedNonEmptyString,
});
export type RelayManagedEndpointRecoveryRegistrationRequest =
  typeof RelayManagedEndpointRecoveryRegistrationRequest.Type;

export const RelayManagedEndpointRecoveryRegistrationResponse = Schema.Struct({
  status: Schema.Literals(["ready", "recovery_required"]),
});
export type RelayManagedEndpointRecoveryRegistrationResponse =
  typeof RelayManagedEndpointRecoveryRegistrationResponse.Type;

export const RelayManagedEndpointRecoveryResponse = Schema.Struct({
  endpoint: RelayManagedEndpoint,
  endpointRuntime: RelayManagedEndpointRuntimeConfig,
});
export type RelayManagedEndpointRecoveryResponse = typeof RelayManagedEndpointRecoveryResponse.Type;

export const RelayLinkProofRequest = Schema.Struct({
  challenge: Schema.String,
  relayIssuer: Schema.String,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
});
export type RelayLinkProofRequest = typeof RelayLinkProofRequest.Type;

export const RelayEnvironmentConfigRequest = Schema.Struct({
  relayUrl: Schema.String,
  relayIssuer: Schema.optional(Schema.String),
  cloudUserId: Schema.String,
  environmentCredential: Schema.String,
  cloudMintPublicKey: Schema.String,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
});
export type RelayEnvironmentConfigRequest = typeof RelayEnvironmentConfigRequest.Type;

const RelaySignedJwtRegisteredClaims = {
  iss: TrimmedNonEmptyString,
  aud: TrimmedNonEmptyString,
  sub: TrimmedNonEmptyString,
  jti: TrimmedNonEmptyString,
  iat: Schema.Int,
  exp: Schema.Int,
} as const;

export const RelayManagedEndpointRecoveryProofPayload = Schema.Union([
  Schema.Struct({
    ...RelaySignedJwtRegisteredClaims,
    action: Schema.Literal("register"),
    environmentId: EnvironmentId,
    cloudUserId: TrimmedNonEmptyString,
    tunnelId: TrimmedNonEmptyString,
    origin: RelayManagedEndpointOrigin,
  }),
  Schema.Struct({
    ...RelaySignedJwtRegisteredClaims,
    action: Schema.Literal("recover"),
    environmentId: EnvironmentId,
    cloudUserId: TrimmedNonEmptyString,
    origin: RelayManagedEndpointOrigin,
  }),
]);
export type RelayManagedEndpointRecoveryProofPayload =
  typeof RelayManagedEndpointRecoveryProofPayload.Type;

export const RelayAgentActivityPublishProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  state: Schema.NullOr(RelayAgentActivityState),
});
export type RelayAgentActivityPublishProofPayload =
  typeof RelayAgentActivityPublishProofPayload.Type;
export type RelayAgentActivityPublishProof = string;

export const RelayAgentActivityPublishRequest = Schema.Struct({
  state: Schema.NullOr(RelayAgentActivityState).annotate({
    description: "Current agent-awareness state, or null to remove the published state.",
  }),
  proof: TrimmedNonEmptyString.annotate({
    description: "Environment-signed JWT covering this published activity state.",
  }),
}).annotate({ description: "Publishes a signed agent-awareness update from an environment." });
export type RelayAgentActivityPublishRequest = typeof RelayAgentActivityPublishRequest.Type;

export const RelayEnvironmentLinkScope = Schema.Literals([
  "agent_activity_notifications",
  "managed_tunnels",
]);
export type RelayEnvironmentLinkScope = typeof RelayEnvironmentLinkScope.Type;

export const RelayEnvironmentLinkProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  challenge: TrimmedNonEmptyString,
  descriptor: ExecutionEnvironmentDescriptor,
  environmentId: EnvironmentId,
  environmentPublicKey: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  origin: RelayManagedEndpointOrigin,
  scopes: Schema.Array(RelayEnvironmentLinkScope),
});
export type RelayEnvironmentLinkProofPayload = typeof RelayEnvironmentLinkProofPayload.Type;

export const RelayEnvironmentLinkProof = TrimmedNonEmptyString;
export type RelayEnvironmentLinkProof = typeof RelayEnvironmentLinkProof.Type;

export const RelayEnvironmentLinkChallengeRequest = Schema.Struct({
  notificationsEnabled: Schema.Boolean.annotate({
    description: "Whether this link may deliver push notifications.",
  }),
  liveActivitiesEnabled: Schema.Boolean.annotate({
    description: "Whether this link may update Live Activities.",
  }),
  managedTunnelsEnabled: Schema.Boolean.annotate({
    description: "Whether the relay should provision a managed tunnel for this environment.",
  }),
}).annotate({ description: "Requested capabilities for a new environment-link challenge." });
export type RelayEnvironmentLinkChallengeRequest = typeof RelayEnvironmentLinkChallengeRequest.Type;

export const RelayEnvironmentLinkChallengeResponse = Schema.Struct({
  challenge: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentLinkChallengeResponse =
  typeof RelayEnvironmentLinkChallengeResponse.Type;

export const RelayEnvironmentLinkRequest = Schema.Struct({
  deviceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional client device identifier associated with this link.",
    }),
  ),
  proof: RelayEnvironmentLinkProof.annotate({
    description: "Environment-signed proof bound to a previously issued link challenge.",
  }),
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  managedTunnelsEnabled: Schema.Boolean,
}).annotate({ description: "Links an authenticated cloud user to a fwai environment." });
export type RelayEnvironmentLinkRequest = typeof RelayEnvironmentLinkRequest.Type;

export const RelayEnvironmentLinkResponse = Schema.Struct({
  ok: Schema.Boolean,
  cloudUserId: TrimmedNonEmptyString,
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  endpointRuntime: Schema.NullOr(RelayManagedEndpointRuntimeConfig),
  relayIssuer: TrimmedNonEmptyString,
  environmentCredential: TrimmedNonEmptyString,
  cloudMintPublicKey: TrimmedNonEmptyString,
});
export type RelayEnvironmentLinkResponse = typeof RelayEnvironmentLinkResponse.Type;

export const RelayEnvironmentLinkProofInvalidReason = Schema.Literals([
  "invalid_signature_or_scope",
  "descriptor_mismatch",
  "replayed_nonce",
  "challenge_invalid",
  "origin_not_allowed",
  "endpoint_not_secure",
]);
export type RelayEnvironmentLinkProofInvalidReason =
  typeof RelayEnvironmentLinkProofInvalidReason.Type;

export const RelayEnvironmentLinkFailedReason = Schema.Literals([
  "link_persistence_failed",
  "credential_persistence_failed",
  "replay_persistence_failed",
  "internal_error",
]);
export type RelayEnvironmentLinkFailedReason = typeof RelayEnvironmentLinkFailedReason.Type;

export const RelayEnvironmentLinkUnavailableReason = Schema.Literals([
  "managed_endpoint_not_configured",
  "managed_endpoint_provisioning_failed",
]);
export type RelayEnvironmentLinkUnavailableReason =
  typeof RelayEnvironmentLinkUnavailableReason.Type;

export const RelayEnvironmentEndpointUnavailableReason = Schema.Literals([
  "endpoint_request_failed",
  "endpoint_response_invalid",
]);
export type RelayEnvironmentEndpointUnavailableReason =
  typeof RelayEnvironmentEndpointUnavailableReason.Type;

/**
 * Which part of the path from the relay to the environment failed. `tunnel_down`
 * means Cloudflare has no live connector for the tunnel; `origin_unreachable`
 * means the tunnel answered but T3 Code behind it did not. Optional on the wire
 * so old relays and old clients keep working.
 */
export const RelayEnvironmentEndpointFailure = Schema.Literals([
  "tunnel_down",
  "origin_unreachable",
  "dns",
  "tls",
  "refused",
  "timeout",
  "invalid_response",
  "unknown",
]);
export type RelayEnvironmentEndpointFailure = typeof RelayEnvironmentEndpointFailure.Type;

export const RelayAgentActivityPublishProofInvalidReason = Schema.Literals([
  "invalid_signature_or_payload",
  "replayed_nonce",
]);
export type RelayAgentActivityPublishProofInvalidReason =
  typeof RelayAgentActivityPublishProofInvalidReason.Type;

export const RelayAuthInvalidReason = Schema.Literals([
  "missing_bearer",
  "invalid_bearer",
  "invalid_dpop",
  "not_authorized",
]);
export type RelayAuthInvalidReason = typeof RelayAuthInvalidReason.Type;

export const RelayDpopFailureReason = DpopFailureReason;
export type RelayDpopFailureReason = typeof RelayDpopFailureReason.Type;

export const RelayInternalErrorReason = Schema.Literals([
  "database_unavailable",
  "persistence_failed",
  "upstream_unavailable",
  "internal_error",
]);
export type RelayInternalErrorReason = typeof RelayInternalErrorReason.Type;

export class RelayAuthInvalidError extends Schema.TaggedError<RelayAuthInvalidError>()(
  "RelayAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: RelayAuthInvalidReason,
    dpopFailureReason: Schema.optionalKey(RelayDpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay authentication failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkProofExpiredError extends Schema.TaggedError<RelayEnvironmentLinkProofExpiredError>()(
  "RelayEnvironmentLinkProofExpiredError",
  {
    code: Schema.Literal("environment_link_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay environment link proof expired";
  }
}

export class RelayEnvironmentLinkProofInvalidError extends Schema.TaggedError<RelayEnvironmentLinkProofInvalidError>()(
  "RelayEnvironmentLinkProofInvalidError",
  {
    code: Schema.Literal("environment_link_proof_invalid"),
    reason: RelayEnvironmentLinkProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return `Relay environment link proof is invalid: ${this.reason}`;
  }
}

export const RelayEnvironmentConnectNotAuthorizedReason = Schema.Literals([
  "client_proof_key_thumbprint_missing",
  "environment_link_not_found",
  "endpoint_provider_not_managed",
  "managed_endpoint_allocation_not_found",
  "managed_endpoint_base_domain_not_configured",
  "managed_endpoint_allocation_not_ready",
  "managed_endpoint_hostname_invalid",
  "managed_endpoint_mismatch",
]);
export type RelayEnvironmentConnectNotAuthorizedReason =
  typeof RelayEnvironmentConnectNotAuthorizedReason.Type;

export class RelayEnvironmentConnectNotAuthorizedError extends Schema.TaggedError<RelayEnvironmentConnectNotAuthorizedError>()(
  "RelayEnvironmentConnectNotAuthorizedError",
  {
    code: Schema.Literal("environment_connect_not_authorized"),
    reason: Schema.optional(RelayEnvironmentConnectNotAuthorizedReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return this.reason
      ? `Relay environment connection is not authorized: ${this.reason}`
      : "Relay environment connection is not authorized";
  }
}

export class RelayEnvironmentEndpointUnavailableError extends Schema.TaggedError<RelayEnvironmentEndpointUnavailableError>()(
  "RelayEnvironmentEndpointUnavailableError",
  {
    code: Schema.Literal("environment_endpoint_unavailable"),
    reason: RelayEnvironmentEndpointUnavailableReason,
    endpointFailure: Schema.optionalKey(RelayEnvironmentEndpointFailure),
    endpointStatus: Schema.optionalKey(Schema.Number),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `Relay environment endpoint is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentEndpointTimedOutError extends Schema.TaggedError<RelayEnvironmentEndpointTimedOutError>()(
  "RelayEnvironmentEndpointTimedOutError",
  {
    code: Schema.Literal("environment_endpoint_timed_out"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 504 },
) {
  override get message(): string {
    return "Relay environment endpoint request timed out";
  }
}

export class RelayEnvironmentLinkFailedError extends Schema.TaggedError<RelayEnvironmentLinkFailedError>()(
  "RelayEnvironmentLinkFailedError",
  {
    code: Schema.Literal("environment_link_failed"),
    reason: RelayEnvironmentLinkFailedReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay environment link failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkUnavailableError extends Schema.TaggedError<RelayEnvironmentLinkUnavailableError>()(
  "RelayEnvironmentLinkUnavailableError",
  {
    code: Schema.Literal("environment_link_unavailable"),
    reason: RelayEnvironmentLinkUnavailableReason,
    provisioningStage: Schema.optionalKey(TrimmedNonEmptyString),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Relay environment link is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkLimitExceededError extends Schema.TaggedError<RelayEnvironmentLinkLimitExceededError>()(
  "RelayEnvironmentLinkLimitExceededError",
  {
    code: Schema.Literal("environment_link_limit_exceeded"),
    maxTunnels: Schema.Number,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `Relay managed tunnel limit reached: this account allows at most ${this.maxTunnels} tunnels`;
  }
}

export class RelayAgentActivityPublishProofExpiredError extends Schema.TaggedError<RelayAgentActivityPublishProofExpiredError>()(
  "RelayAgentActivityPublishProofExpiredError",
  {
    code: Schema.Literal("agent_activity_publish_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay agent activity publish proof expired";
  }
}

export class RelayAgentActivityPublishProofInvalidError extends Schema.TaggedError<RelayAgentActivityPublishProofInvalidError>()(
  "RelayAgentActivityPublishProofInvalidError",
  {
    code: Schema.Literal("agent_activity_publish_proof_invalid"),
    reason: RelayAgentActivityPublishProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay agent activity publish proof is invalid: ${this.reason}`;
  }
}

export class RelayInternalError extends Schema.TaggedError<RelayInternalError>()(
  "RelayInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: RelayInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay internal error: ${this.reason}`;
  }
}

export const RelayProtectedError = Schema.Union([
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayInternalError,
]);
export type RelayProtectedError = typeof RelayProtectedError.Type;

const RelayAuthAndInternalErrors = [RelayAuthInvalidError, RelayInternalError] as const;

const RelayEnvironmentLinkErrors = [
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayEnvironmentLinkFailedError,
  RelayInternalError,
] as const;

const RelayEnvironmentConnectErrors = [
  RelayAuthInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayInternalError,
] as const;

const RelayAgentActivityPublishErrors = [
  RelayAuthInvalidError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayInternalError,
] as const;

export class RelayClientPrincipal extends Context.Service<
  RelayClientPrincipal,
  {
    readonly userId: string;
    readonly token: string;
    readonly proofKeyThumbprint?: string;
    readonly dpopScopes?: ReadonlyArray<RelayDpopAccessTokenScope>;
    /** From gateway introspection, as of when the relay token was issued. */
    readonly organization?: RelayAccountOrganization | null;
  }
>()("@t3tools/contracts/relay/RelayClientPrincipal") {}

export class RelayEnvironmentPrincipal extends Context.Service<
  RelayEnvironmentPrincipal,
  {
    readonly environmentId: string;
    readonly environmentPublicKey: string;
  }
>()("@t3tools/contracts/relay/RelayEnvironmentPrincipal") {}

const RelayClientBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "fwai gateway access token for the signed-in user.",
  ),
);

export class RelayClientAuth extends HttpApiMiddleware.Service<
  RelayClientAuth,
  { provides: RelayClientPrincipal }
>()("RelayClientAuth", {
  error: RelayAuthInvalidError,
  security: { clientBearer: RelayClientBearerAuthorization },
}) {}

const RelayEnvironmentBearerAuthorization = HttpApiSecurity.http({ scheme: "bearer" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "Relay-issued environment credential installed when the environment is linked.",
  ),
);

export class RelayEnvironmentAuth extends HttpApiMiddleware.Service<
  RelayEnvironmentAuth,
  { provides: RelayEnvironmentPrincipal }
>()("RelayEnvironmentAuth", {
  error: [RelayAuthInvalidError, RelayInternalError],
  security: { environmentBearer: RelayEnvironmentBearerAuthorization },
}) {}

const RelayDpopAuthorization = HttpApiSecurity.http({ scheme: "DPoP" }).pipe(
  HttpApiSecurity.annotate(
    OpenApi.Description,
    "DPoP-bound access token. Requests must also include the DPoP proof JWT header.",
  ),
);

export class RelayDpopClientAuth extends HttpApiMiddleware.Service<
  RelayDpopClientAuth,
  { provides: RelayClientPrincipal }
>()("RelayDpopClientAuth", {
  error: RelayAuthInvalidError,
  security: { relayDpop: RelayDpopAuthorization },
}) {}

export const RelayClientEnvironmentRecord = Schema.Struct({
  environmentId: EnvironmentId,
  label: TrimmedNonEmptyString,
  endpoint: RelayManagedEndpoint,
  linkedAt: TrimmedNonEmptyString,
});
export type RelayClientEnvironmentRecord = typeof RelayClientEnvironmentRecord.Type;

export const RelayListEnvironmentsResponse = Schema.Struct({
  environments: Schema.Array(RelayClientEnvironmentRecord),
});
export type RelayListEnvironmentsResponse = typeof RelayListEnvironmentsResponse.Type;

export const RelayEnvironmentConnectRequest = Schema.Struct({
  deviceId: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Optional client device identifier requesting the connection.",
    }),
  ),
  clientKeyThumbprint: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Deprecated alias for clientProofKeyThumbprint.",
    }),
  ),
  clientProofKeyThumbprint: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "JWK thumbprint that the minted environment credential must be bound to.",
    }),
  ),
}).annotate({ description: "Requests a short-lived credential for connecting to an environment." });
export type RelayEnvironmentConnectRequest = typeof RelayEnvironmentConnectRequest.Type;

export const RelayEnvironmentConnectScope = "environment:connect" as const;
export const RelayEnvironmentStatusScope = "environment:status" as const;
export const RelayMobileRegistrationScope = "mobile:registration" as const;
export const RelayDpopAccessTokenScope = Schema.Literals([
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileRegistrationScope,
]);
export type RelayDpopAccessTokenScope = typeof RelayDpopAccessTokenScope.Type;

export const RelayDpopTokenExchangeGrantType =
  "urn:ietf:params:oauth:grant-type:token-exchange" as const;
export const RelayJwtSubjectTokenType = "urn:ietf:params:oauth:token-type:jwt" as const;
export const RelayAccessTokenType = "urn:ietf:params:oauth:token-type:access_token" as const;
export const RelayPublicClientId = Schema.Literals(["t3-mobile", "t3-web"]);
export type RelayPublicClientId = typeof RelayPublicClientId.Type;
export const RelayMobileClientId = "t3-mobile" as const;
export const RelayWebClientId = "t3-web" as const;

export const RelayDpopAccessTokenRequest = Schema.Struct({
  grant_type: Schema.Literal(RelayDpopTokenExchangeGrantType),
  subject_token: TrimmedNonEmptyString.annotate({
    description: "fwai gateway access token for the signed-in user.",
  }),
  subject_token_type: Schema.Literal(RelayJwtSubjectTokenType),
  requested_token_type: Schema.Literal(RelayAccessTokenType),
  resource: TrimmedNonEmptyString.annotate({
    description: "Relay issuer URL that will receive the DPoP-bound access token.",
  }),
  scope: TrimmedNonEmptyString.annotate({
    description: "Space-separated relay scopes requested by the client.",
  }),
  client_id: RelayPublicClientId,
})
  .annotate({ description: "OAuth token exchange request for a DPoP-bound relay access token." })
  .pipe(HttpApiSchema.asFormUrlEncoded());
export type RelayDpopAccessTokenRequest = typeof RelayDpopAccessTokenRequest.Type;

export const RelayDpopAccessTokenResponse = Schema.Struct({
  access_token: TrimmedNonEmptyString,
  issued_token_type: Schema.Literal(RelayAccessTokenType),
  token_type: Schema.Literal("DPoP"),
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: TrimmedNonEmptyString,
});
export type RelayDpopAccessTokenResponse = typeof RelayDpopAccessTokenResponse.Type;

export const RelayBearerRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
});

export const RelayDpopProofRequestHeaders = Schema.Struct({
  dpop: TrimmedNonEmptyString,
});

export const RelayDpopRequestHeaders = Schema.Struct({
  authorization: TrimmedNonEmptyString,
  dpop: TrimmedNonEmptyString,
});

export const RelayAuthorizationServerMetadata = Schema.Struct({
  issuer: TrimmedNonEmptyString,
  token_endpoint: TrimmedNonEmptyString,
  grant_types_supported: Schema.Array(Schema.Literal(RelayDpopTokenExchangeGrantType)),
  token_endpoint_auth_methods_supported: Schema.Array(Schema.Literal("none")),
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
});

export const RelayProtectedResourceMetadata = Schema.Struct({
  resource: TrimmedNonEmptyString,
  authorization_servers: Schema.Array(TrimmedNonEmptyString),
  scopes_supported: Schema.Array(RelayDpopAccessTokenScope),
  dpop_bound_access_tokens_required: Schema.Boolean,
  dpop_signing_alg_values_supported: Schema.Array(Schema.Literal("ES256")),
});

export const RelayEnvironmentUnlinkParams = Schema.Struct({
  environmentId: EnvironmentId,
});
export type RelayEnvironmentUnlinkParams = typeof RelayEnvironmentUnlinkParams.Type;

export const RelayEnvironmentConnectResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentConnectResponse = typeof RelayEnvironmentConnectResponse.Type;

export const RelayEnvironmentStatusValue = Schema.Literals(["online", "offline"]);
export type RelayEnvironmentStatusValue = typeof RelayEnvironmentStatusValue.Type;

const RelayEnvironmentOfflineReason = Schema.Literals(["tunnel_released"]);
type RelayEnvironmentOfflineReason = typeof RelayEnvironmentOfflineReason.Type;

export const RelayEnvironmentStatusResponse = Schema.Struct({
  environmentId: EnvironmentId,
  endpoint: RelayManagedEndpoint,
  status: RelayEnvironmentStatusValue,
  checkedAt: TrimmedNonEmptyString,
  descriptor: Schema.optional(ExecutionEnvironmentDescriptor),
  error: Schema.optional(TrimmedNonEmptyString),
  endpointFailure: Schema.optional(RelayEnvironmentEndpointFailure),
  endpointStatus: Schema.optional(Schema.Number),
  offlineReason: Schema.optional(RelayEnvironmentOfflineReason),
  traceId: Schema.optional(TrimmedNonEmptyString),
});
export type RelayEnvironmentStatusResponse = typeof RelayEnvironmentStatusResponse.Type;

export const RelayAccountOrganization = AuthAccountOrganization;
export type RelayAccountOrganization = AuthAccountOrganization;

/**
 * Someone accepted an invite link (#58). The environment records it as an `account` share with
 * this id, `viaShareId: linkShareId`, and the link's role, if the link still allows it.
 */
export const RelayThreadShareClaim = Schema.Struct({
  threadId: ThreadId,
  shareId: ThreadShareId,
  linkShareId: ThreadShareId,
  accountId: TrimmedNonEmptyString,
  /** Empty when the relay does not know it yet. */
  username: Schema.String,
  claimedAt: TrimmedNonEmptyString,
});
export type RelayThreadShareClaim = typeof RelayThreadShareClaim.Type;

export const RelayCloudMintCredentialProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  cnf: Schema.Struct({
    jkt: TrimmedNonEmptyString,
  }),
  deviceId: Schema.optional(TrimmedNonEmptyString),
  // Absent from relays older than thread sharing; null when the caller is in no organization.
  organization: Schema.optional(Schema.NullOr(RelayAccountOrganization)),
  // Set only for an account other than the linked one: the live shares (#20) the relay matched.
  shareIds: Schema.optional(Schema.Array(ThreadShareId)),
  // Invite links (#58) the caller accepted that the environment has not recorded yet.
  shareClaims: Schema.optional(Schema.Array(RelayThreadShareClaim)),
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:connect")),
});
export type RelayCloudMintCredentialProofPayload = typeof RelayCloudMintCredentialProofPayload.Type;

export const RelayCloudMintCredentialProof = TrimmedNonEmptyString;
export type RelayCloudMintCredentialProof = typeof RelayCloudMintCredentialProof.Type;

export const RelayCloudMintCredentialRequest = Schema.Struct({
  proof: RelayCloudMintCredentialProof,
});
export type RelayCloudMintCredentialRequest = typeof RelayCloudMintCredentialRequest.Type;

export const RelayCloudEnvironmentHealthProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  nonce: TrimmedNonEmptyString,
  scope: Schema.Array(Schema.Literal("environment:status")),
});
export type RelayCloudEnvironmentHealthProofPayload =
  typeof RelayCloudEnvironmentHealthProofPayload.Type;

/** Verify x-t3-relay-delivery with the relay mint key before trusting delivery id, time, or trace context. */
export const RelayHookDeliveryProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  deliveryId: TrimmedNonEmptyString,
  receivedAt: TrimmedNonEmptyString,
  hookId: TrimmedNonEmptyString,
});
export type RelayHookDeliveryProofPayload = typeof RelayHookDeliveryProofPayload.Type;

export const RelayCloudEnvironmentHealthProof = TrimmedNonEmptyString;
export type RelayCloudEnvironmentHealthProof = typeof RelayCloudEnvironmentHealthProof.Type;

export const RelayCloudEnvironmentHealthRequest = Schema.Struct({
  proof: RelayCloudEnvironmentHealthProof,
});
export type RelayCloudEnvironmentHealthRequest = typeof RelayCloudEnvironmentHealthRequest.Type;

export const RelayEnvironmentHealthResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  requestNonce: TrimmedNonEmptyString,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: TrimmedNonEmptyString,
});
export type RelayEnvironmentHealthResponseProofPayload =
  typeof RelayEnvironmentHealthResponseProofPayload.Type;

export const RelayEnvironmentHealthResponse = Schema.Struct({
  environmentId: EnvironmentId,
  status: Schema.Literal("online"),
  descriptor: ExecutionEnvironmentDescriptor,
  checkedAt: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentHealthResponse = typeof RelayEnvironmentHealthResponse.Type;

export const RelayEnvironmentMintResponseProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  clientProofKeyThumbprint: TrimmedNonEmptyString,
  requestNonce: TrimmedNonEmptyString,
  credential: TrimmedNonEmptyString,
});
export type RelayEnvironmentMintResponseProofPayload =
  typeof RelayEnvironmentMintResponseProofPayload.Type;

export const RelayEnvironmentMintResponse = Schema.Struct({
  credential: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
  proof: TrimmedNonEmptyString,
});
export type RelayEnvironmentMintResponse = typeof RelayEnvironmentMintResponse.Type;

export const RelayDeliveryKind = Schema.Literals([
  "live_activity_start",
  "live_activity_update",
  "live_activity_end",
  "push_notification",
]);
export type RelayDeliveryKind = typeof RelayDeliveryKind.Type;

export const RelayDeliveryResult = Schema.Struct({
  deviceId: TrimmedNonEmptyString,
  kind: RelayDeliveryKind,
  ok: Schema.Boolean,
  queued: Schema.optional(Schema.Boolean),
  apnsStatus: Schema.NullOr(Schema.Number),
  apnsReason: Schema.NullOr(Schema.String),
  apnsId: Schema.NullOr(Schema.String),
});
export type RelayDeliveryResult = typeof RelayDeliveryResult.Type;

export const RelayOkResponse = Schema.Struct({
  ok: Schema.Boolean,
});
export type RelayOkResponse = typeof RelayOkResponse.Type;

export const RelayPublishResponse = Schema.Struct({
  ok: Schema.Boolean,
  deliveries: Schema.Array(RelayDeliveryResult),
});
export type RelayPublishResponse = typeof RelayPublishResponse.Type;

export const RelayHealthResponse = Schema.Struct({
  ok: Schema.Boolean,
  service: Schema.Literal("relay"),
});
export type RelayHealthResponse = typeof RelayHealthResponse.Type;

// fwai: thread sharing (#20). The owner's environment pushes its grants; the relay decides their
// status from the owner's organization, lists them to the people they match and admits them at
// connect. The environment still decides every access itself.
export const RelayThreadGrantSyncRequest = Schema.Struct({
  title: Schema.String.check(Schema.isMaxLength(512)),
  /** Every share the thread has now; an empty list removes the thread's grants. */
  shares: Schema.Array(ThreadShare).check(Schema.isMaxLength(THREAD_SHARE_LIMIT)),
});
export type RelayThreadGrantSyncRequest = typeof RelayThreadGrantSyncRequest.Type;

export const RelayThreadGrantStatus = Schema.Struct({
  id: ThreadShareId,
  status: ThreadShareStatus,
});
export type RelayThreadGrantStatus = typeof RelayThreadGrantStatus.Type;

export const RelayThreadGrantSyncResponse = Schema.Struct({
  shares: Schema.Array(RelayThreadGrantStatus),
  /** Absent from relays older than invite links. */
  claims: Schema.optional(Schema.Array(RelayThreadShareClaim)),
});
export type RelayThreadGrantSyncResponse = typeof RelayThreadGrantSyncResponse.Type;

export const RelayThreadGrantListResponse = Schema.Struct({
  grants: Schema.Array(
    Schema.Struct({
      threadId: ThreadId,
      id: ThreadShareId,
      status: ThreadShareStatus,
    }),
  ),
  claims: Schema.optional(Schema.Array(RelayThreadShareClaim)),
});
export type RelayThreadGrantListResponse = typeof RelayThreadGrantListResponse.Type;

export const RelayOrgShareRequestId = TrimmedNonEmptyString;

export const RelayOrgShareRequest = Schema.Struct({
  /** The relay's id for the request; not the environment's share id. */
  id: RelayOrgShareRequestId,
  environmentId: EnvironmentId,
  threadId: ThreadId,
  shareId: ThreadShareId,
  title: Schema.String,
  ownerSub: TrimmedNonEmptyString,
  role: ThreadShareRole,
  requestedAt: TrimmedNonEmptyString,
});
export type RelayOrgShareRequest = typeof RelayOrgShareRequest.Type;

export const RelayOrgShareRequestListResponse = Schema.Struct({
  requests: Schema.Array(RelayOrgShareRequest),
});
export type RelayOrgShareRequestListResponse = typeof RelayOrgShareRequestListResponse.Type;

export const RelayOrgShareDecisionResponse = Schema.Struct({
  id: RelayOrgShareRequestId,
  status: ThreadShareStatus,
});
export type RelayOrgShareDecisionResponse = typeof RelayOrgShareDecisionResponse.Type;

export class RelayOrgShareNotAuthorizedError extends Schema.TaggedError<RelayOrgShareNotAuthorizedError>()(
  "RelayOrgShareNotAuthorizedError",
  {
    code: Schema.Literal("org_share_not_authorized"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Only organization owners can decide whole-organization shares";
  }
}

export class RelayOrgShareRequestNotFoundError extends Schema.TaggedError<RelayOrgShareRequestNotFoundError>()(
  "RelayOrgShareRequestNotFoundError",
  {
    code: Schema.Literal("org_share_request_not_found"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "The share request does not exist or was already withdrawn";
  }
}

const RelayOrgShareErrors = [
  RelayAuthInvalidError,
  RelayOrgShareNotAuthorizedError,
  RelayOrgShareRequestNotFoundError,
  RelayInternalError,
] as const;

export const RelaySharedThread = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  ownerSub: TrimmedNonEmptyString,
  role: ThreadShareRole,
  targetKind: ThreadShareTargetKind,
  /** The owner's environment reported in recently; it may still be unreachable. */
  online: Schema.Boolean,
});
export type RelaySharedThread = typeof RelaySharedThread.Type;

export const RelaySharedThreadsResponse = Schema.Struct({
  threads: Schema.Array(RelaySharedThread),
});
export type RelaySharedThreadsResponse = typeof RelaySharedThreadsResponse.Type;

// fwai: invite links (#58). The token travels only in the path; the relay looks it up by hash.
export const RelayThreadInviteToken = TrimmedNonEmptyString.check(Schema.isMaxLength(128));

export const RelayThreadInvitePreview = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  /** Empty when the relay does not know it yet. */
  ownerUsername: Schema.String,
  role: ThreadShareRole,
  requireApproval: Schema.Boolean,
  mode: Schema.Literals(["single", "multi"]),
  /** The caller already joined through this link. */
  joined: Schema.Boolean,
  /** The caller owns the thread. */
  own: Schema.Boolean,
});
export type RelayThreadInvitePreview = typeof RelayThreadInvitePreview.Type;

export const RelayThreadInviteAcceptResponse = Schema.Struct({
  environmentId: EnvironmentId,
  threadId: ThreadId,
  role: ThreadShareRole,
  own: Schema.Boolean,
});
export type RelayThreadInviteAcceptResponse = typeof RelayThreadInviteAcceptResponse.Type;

/** Unknown, expired, revoked, used by someone else or full: the caller cannot tell which. */
export class RelayThreadInviteUnavailableError extends Schema.TaggedError<RelayThreadInviteUnavailableError>()(
  "RelayThreadInviteUnavailableError",
  {
    code: Schema.Literal("invite_unavailable"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 404 },
) {
  override get message(): string {
    return "This link no longer works. Ask for a new one.";
  }
}

export class RelayThreadInviteRateLimitedError extends Schema.TaggedError<RelayThreadInviteRateLimitedError>()(
  "RelayThreadInviteRateLimitedError",
  {
    code: Schema.Literal("rate_limited"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 429 },
) {
  override get message(): string {
    return "Too many attempts. Try again in a minute.";
  }
}

const RelayThreadInviteErrors = [
  RelayAuthInvalidError,
  RelayThreadInviteUnavailableError,
  RelayThreadInviteRateLimitedError,
  RelayInternalError,
] as const;

// fwai: linked threads across environments (#21 phase 2). An environment posts a small envelope
// with its environment credential; the relay authorizes it, sets the acting account from the
// sender's link, and forwards it through the target's tunnel with a signed delivery proof. The
// target environment decides again. Envelopes are rare and never a stream.
export const RELAY_LINK_TEXT_MAX_LENGTH = 32_000;
export const RELAY_LINK_PRESENCE_MAX_TARGETS = 16;
/** Where the relay posts an envelope on the target environment. */
export const RELAY_LINK_ENVELOPE_ROUTE = "/api/link/envelope";

/** Names what the envelope is about (a task, a membership), so a resend replaces it. */
export const RelayLinkEnvelopeId = TrimmedNonEmptyString.check(Schema.isMaxLength(1024));

/** A member as the group's home environment describes it to the others. */
export const RelayLinkMemberInfo = Schema.Struct({
  ...LinkThreadRef.fields,
  purpose: LinkPurpose,
  title: Schema.String.check(Schema.isMaxLength(512)),
  /** The owner's username where the home environment knows it. */
  owner: Schema.NullOr(Schema.String.check(Schema.isMaxLength(191))),
});
export type RelayLinkMemberInfo = typeof RelayLinkMemberInfo.Type;

const RelayLinkText = Schema.String.check(Schema.isMaxLength(RELAY_LINK_TEXT_MAX_LENGTH));

export const RelayLinkEnvelopeBody = Schema.Union([
  /** Requester to assignee. `taskId` is the requester's task record. */
  Schema.Struct({
    kind: Schema.Literal("task"),
    taskId: NodeId,
    chainId: LinkChainId,
    hop: PositiveInt,
    parentTaskId: Schema.NullOr(NodeId),
    text: RelayLinkText.check(Schema.isMinLength(1)),
    sender: LinkTaskSender,
    /** The requester's mode; the assignee never runs broader than it. */
    requesterRuntimeMode: RuntimeMode,
  }),
  /** Assignee to requester, as its run changes state. Not in #21's list: approval waits need it. */
  Schema.Struct({
    kind: Schema.Literal("status"),
    taskId: NodeId,
    state: Schema.Literals(["queued", "running", "waiting_for_owner_approval"]),
  }),
  /** Assignee to requester, once, when the run that handled the task ends. */
  Schema.Struct({
    kind: Schema.Literal("result"),
    taskId: NodeId,
    outcome: Schema.Literals(["completed", "failed", "interrupted", "stopped"]),
    text: RelayLinkText,
    /** Who stopped it on the assignee's side, for "stopped by …". */
    stoppedBy: Schema.optional(Schema.String.check(Schema.isMaxLength(200))),
  }),
  /** Requester to assignee: stop the task and the tasks derived from it. */
  Schema.Struct({
    kind: Schema.Literal("cancel"),
    taskId: NodeId,
    stoppedBy: Schema.String.check(Schema.isMaxLength(200)),
  }),
  /** Home to member: you are in this group, which now looks like this. */
  Schema.Struct({
    kind: Schema.Literal("member-joined"),
    linkName: LinkName,
    status: LinkGroupStatus,
    members: Schema.Array(RelayLinkMemberInfo).check(Schema.isMaxLength(LINK_MAX_MEMBERS)),
    /** Grows with every change at the home; a member ignores a view older than the one it holds. */
    version: Schema.optional(NonNegativeInt),
  }),
  /** Home to member: you left the group; or member to home: my thread left it. */
  Schema.Struct({
    kind: Schema.Literal("member-left"),
    reason: Schema.optional(LinkMemberRemovalReason),
  }),
  /** Member to member: one line on what the sender's run just did (#37). */
  Schema.Struct({
    kind: Schema.Literal("activity"),
    entry: LinkActivityEntry,
  }),
]);
export type RelayLinkEnvelopeBody = typeof RelayLinkEnvelopeBody.Type;
export type RelayLinkEnvelopeKind = RelayLinkEnvelopeBody["kind"];

export const RelayLinkEnvelope = Schema.Struct({
  id: RelayLinkEnvelopeId,
  linkId: LinkGroupId,
  sender: LinkThreadRef,
  target: LinkThreadRef,
  /** Ignored by the relay, which sets the acting account from the sender's link. */
  actingAccountId: Schema.optional(Schema.String),
  body: RelayLinkEnvelopeBody,
});
export type RelayLinkEnvelope = typeof RelayLinkEnvelope.Type;

/** What the target environment receives; every field outside the envelope is the relay's. */
export const RelayLinkDelivery = Schema.Struct({
  ...RelayLinkEnvelope.fields,
  actingAccountId: TrimmedNonEmptyString,
  actingOrganization: Schema.NullOr(AuthAccountOrganization),
  /** How the relay authorized it; the target re-checks `shared` against its own shares. */
  relation: Schema.Literals(["same_account", "shared"]),
  receivedAt: TrimmedNonEmptyString,
});
export type RelayLinkDelivery = typeof RelayLinkDelivery.Type;

export const RelayLinkReceiptCode = Schema.Literals([
  "not_authorized",
  "not_a_peer",
  "hop_limit",
  "cycle",
  "chain_stopped",
  "link_paused",
  "rate_limited",
  "unavailable",
  "invalid",
]);
export type RelayLinkReceiptCode = typeof RelayLinkReceiptCode.Type;

/** The target environment's answer, which the relay hands back to the sender. */
export const RelayLinkReceipt = Schema.Struct({
  accepted: Schema.Boolean,
  code: Schema.optional(RelayLinkReceiptCode),
  message: Schema.optional(Schema.String.check(Schema.isMaxLength(500))),
  /** Whether the target's commands wait for its owner's approval, for this sender. */
  requiresApproval: Schema.optional(Schema.Boolean),
});
export type RelayLinkReceipt = typeof RelayLinkReceipt.Type;

export const RelayLinkSendResponse = Schema.Struct({
  outcome: Schema.Literals(["delivered", "not_authorized", "peer_offline", "rate_limited"]),
  /** Present when delivered. */
  receipt: Schema.optional(RelayLinkReceipt),
});
export type RelayLinkSendResponse = typeof RelayLinkSendResponse.Type;

export const RelayLinkPresenceRequest = Schema.Struct({
  sender: LinkThreadRef,
  targets: Schema.Array(LinkThreadRef).check(Schema.isMaxLength(RELAY_LINK_PRESENCE_MAX_TARGETS)),
});
export type RelayLinkPresenceRequest = typeof RelayLinkPresenceRequest.Type;

export const RelayLinkPresenceResponse = Schema.Struct({
  peers: Schema.Array(
    Schema.Struct({
      ...LinkThreadRef.fields,
      /** The relay would forward a task between the two threads. */
      authorized: Schema.Boolean,
      online: Schema.Boolean,
      relation: Schema.optional(Schema.Literals(["same_account", "shared"])),
    }),
  ),
});
export type RelayLinkPresenceResponse = typeof RelayLinkPresenceResponse.Type;

/** Signed with the relay mint key; binds the delivery to its exact body. */
export const RelayLinkDeliveryProofPayload = Schema.Struct({
  ...RelaySignedJwtRegisteredClaims,
  environmentId: EnvironmentId,
  envelopeId: RelayLinkEnvelopeId,
  bodySha256: TrimmedNonEmptyString,
});
export type RelayLinkDeliveryProofPayload = typeof RelayLinkDeliveryProofPayload.Type;

// fwai: personal agent (#22). The relay holds every request in the recipient's inbox, sets the
// sender from the environment link, checks one organization, and posts small envelopes to the
// environments involved. Decisions come from any client, so they work while the agent is offline.
export const RELAY_AGENT_ENVELOPE_ROUTE = "/api/agent/envelope";

export const RelayAgentEnableRequest = Schema.Struct({
  enabled: Schema.Boolean,
  /** The agent thread on this environment; required when enabling. */
  threadId: Schema.optional(ThreadId),
});
export type RelayAgentEnableRequest = typeof RelayAgentEnableRequest.Type;

export const RelayAgentRecordResponse = Schema.Struct({
  agent: Schema.NullOr(AgentEnvironmentRecord),
});
export type RelayAgentRecordResponse = typeof RelayAgentRecordResponse.Type;

export const RelayAgentCreateRequest = Schema.Struct({
  toAccountId: AgentAccountId,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(AGENT_REQUEST_BODY_MAX_LENGTH)),
  context: Schema.optional(Schema.String.check(Schema.isMaxLength(AGENT_REQUEST_BODY_MAX_LENGTH))),
  threadId: ThreadId,
  threadTitle: Schema.String.check(Schema.isMaxLength(512)),
});
export type RelayAgentCreateRequest = typeof RelayAgentCreateRequest.Type;

export const RelayAgentCreateOutcome = Schema.Literals([
  "created",
  /** No fwai account has that id; not the same as one in another organization. */
  "unknown_account",
  "not_authorized",
  "no_agent",
  "blocked",
  "rate_limited",
]);
export type RelayAgentCreateOutcome = typeof RelayAgentCreateOutcome.Type;

export const RelayAgentCreateResponse = Schema.Struct({
  outcome: RelayAgentCreateOutcome,
  request: Schema.optional(AgentRequest),
});
export type RelayAgentCreateResponse = typeof RelayAgentCreateResponse.Type;

/** A colleague whose agent the environment's owner can ask now. */
export const RelayAgentColleague = Schema.Struct({
  accountId: AgentAccountId,
  /** Null for an account the relay has not seen since the gateway started sending usernames. */
  username: Schema.NullOr(Schema.String),
});
export type RelayAgentColleague = typeof RelayAgentColleague.Type;

export const RelayAgentColleaguesResponse = Schema.Struct({
  colleagues: Schema.Array(RelayAgentColleague),
});
export type RelayAgentColleaguesResponse = typeof RelayAgentColleaguesResponse.Type;

/** What an environment reads on start and after each envelope. */
export const RelayAgentSyncResponse = Schema.Struct({
  agent: Schema.NullOr(AgentEnvironmentRecord),
  /** Open requests to this account, when this environment is its agent environment. */
  inbox: Schema.Array(AgentRequest),
  /** Requests sent from this environment's threads, recently changed. */
  outbox: Schema.Array(AgentRequest),
});
export type RelayAgentSyncResponse = typeof RelayAgentSyncResponse.Type;

/** A request's earlier, settled requests from the same sender to the same owner, newest first. */
export const RelayAgentPriorRequestsResponse = Schema.Struct({
  requests: Schema.Array(AgentRequest),
});
export type RelayAgentPriorRequestsResponse = typeof RelayAgentPriorRequestsResponse.Type;

export const RelayAgentProposalRequest = Schema.Struct({ proposal: AgentProposal });
export type RelayAgentProposalRequest = typeof RelayAgentProposalRequest.Type;

/**
 * The agent environment approves for its owner what the owner's grants set to auto (#45). Only
 * acceptance, never a forward: forwarding always waits for the owner.
 */
export const RelayAgentRuleDecisionRequest = Schema.Struct({
  action: AgentProposedAction,
  text: Schema.String.check(Schema.isMaxLength(AGENT_REPLY_MAX_LENGTH)),
});
export type RelayAgentRuleDecisionRequest = typeof RelayAgentRuleDecisionRequest.Type;

export const RelayAgentExecutionRequest = Schema.Struct({
  state: AgentExecution.fields.state,
  detail: Schema.optional(Schema.String.check(Schema.isMaxLength(2_000))),
  result: Schema.optional(Schema.String.check(Schema.isMaxLength(AGENT_REPLY_MAX_LENGTH))),
  /** Done with nothing left to report: reply with the text the owner approved on the card. */
  replyWithApprovedText: Schema.optional(Schema.Boolean),
});
export type RelayAgentExecutionRequest = typeof RelayAgentExecutionRequest.Type;

export const RelayAgentRequestResponse = Schema.Struct({ request: AgentRequest });

/** Wrapped so the HTTP client takes the decision union as one payload type. */
export const RelayAgentDecisionRequest = Schema.Struct({ decision: AgentDecision });
export type RelayAgentDecisionRequest = typeof RelayAgentDecisionRequest.Type;
export type RelayAgentRequestResponse = typeof RelayAgentRequestResponse.Type;

export const RelayAgentStateResponse = Schema.Struct({
  agent: Schema.NullOr(AgentEnvironmentRecord),
  blocked: Schema.Array(AgentAccountId),
});
export type RelayAgentStateResponse = typeof RelayAgentStateResponse.Type;

export const RelayAgentAvailabilityRequest = Schema.Struct({
  accountIds: Schema.Array(AgentAccountId).check(Schema.isMaxLength(500)),
});
export const RelayAgentAvailabilityResponse = Schema.Struct({
  /** Colleagues in the caller's organization who have an agent and do not block the caller. */
  available: Schema.Array(AgentAccountId),
});
export type RelayAgentAvailabilityResponse = typeof RelayAgentAvailabilityResponse.Type;

export const RelayAgentRequestsResponse = Schema.Struct({
  inbox: Schema.Array(AgentRequest),
  outbox: Schema.Array(AgentRequest),
});
export type RelayAgentRequestsResponse = typeof RelayAgentRequestsResponse.Type;

export class RelayAgentRequestError extends Schema.TaggedError<RelayAgentRequestError>()(
  "RelayAgentRequestError",
  {
    code: Schema.Literals([
      "agent_request_not_found",
      "agent_request_conflict",
      "agent_not_authorized",
    ]),
    message: Schema.String,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {}

/** What an environment receives at `RELAY_AGENT_ENVELOPE_ROUTE`. */
export const RelayAgentDelivery = Schema.Struct({
  id: RelayLinkEnvelopeId,
  kind: AgentEnvelopeKind,
  targetEnvironmentId: EnvironmentId,
  request: AgentRequest,
  receivedAt: TrimmedNonEmptyString,
});
export type RelayAgentDelivery = typeof RelayAgentDelivery.Type;

/** Push channel hint: re-read `GET /v1/agent-requests`. */
export const RelayAgentRequestsChangedEvent = Schema.Struct({
  type: Schema.Literal("agent-requests-changed"),
});
export type RelayAgentRequestsChangedEvent = typeof RelayAgentRequestsChangedEvent.Type;

const RelayHealthGroup = HttpApiGroup.make("health")
  .add(
    HttpApiEndpoint.get("health", "/health", {
      success: RelayHealthResponse,
      error: RelayInternalError,
    }).annotate(OpenApi.Summary, "Check relay health"),
  )
  .annotate(OpenApi.Description, "Service health and readiness.");

const RelayMetadataGroup = HttpApiGroup.make("metadata")
  .add(
    HttpApiEndpoint.get("authorizationServer", "/.well-known/oauth-authorization-server", {
      success: RelayAuthorizationServerMetadata,
    }).annotate(OpenApi.Summary, "Read OAuth authorization-server metadata"),
    HttpApiEndpoint.get("protectedResource", "/.well-known/oauth-protected-resource", {
      success: RelayProtectedResourceMetadata,
    }).annotate(OpenApi.Summary, "Read OAuth protected-resource metadata"),
  )
  .annotate(OpenApi.Description, "OAuth and DPoP discovery metadata.");

export const RelayRegisterDeviceEndpoint = HttpApiEndpoint.post(
  "registerDevice",
  "/v1/mobile/devices",
  {
    headers: RelayDpopRequestHeaders,
    payload: RelayDeviceRegistrationRequest,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Register or update a mobile device");

export const RelayRegisterLiveActivityEndpoint = HttpApiEndpoint.post(
  "registerLiveActivity",
  "/v1/mobile/live-activities",
  {
    headers: RelayDpopRequestHeaders,
    payload: RelayLiveActivityRegistrationRequest,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Register a Live Activity push token");

export const RelayAgentActivitySnapshotResponse = Schema.Struct({
  aggregate: Schema.NullOr(RelayAgentActivityAggregateState),
});
export type RelayAgentActivitySnapshotResponse = typeof RelayAgentActivitySnapshotResponse.Type;

export const RelayAgentActivitySnapshotEndpoint = HttpApiEndpoint.get(
  "getAgentActivitySnapshot",
  "/v1/mobile/agent-activity",
  {
    headers: RelayDpopRequestHeaders,
    success: RelayAgentActivitySnapshotResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Read the current Live Activity aggregate");

export const RelayUnregisterDeviceEndpoint = HttpApiEndpoint.delete(
  "unregisterDevice",
  "/v1/mobile/devices/:deviceId",
  {
    headers: RelayDpopRequestHeaders,
    params: RelayDeviceUnregistrationParams,
    success: RelayOkResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "Unregister a mobile device");

const RelayMobileGroup = HttpApiGroup.make("mobile")
  .add(
    RelayRegisterDeviceEndpoint,
    RelayRegisterLiveActivityEndpoint,
    RelayAgentActivitySnapshotEndpoint,
    RelayUnregisterDeviceEndpoint,
  )
  .annotate(OpenApi.Description, "Mobile push-notification and Live Activity registration.")
  .middleware(RelayDpopClientAuth);

const RelayClientGroup = HttpApiGroup.make("client")
  .add(
    HttpApiEndpoint.get("listEnvironments", "/v1/environments", {
      headers: RelayBearerRequestHeaders,
      success: RelayListEnvironmentsResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List linked environments"),
    HttpApiEndpoint.get("listDevices", "/v1/client/devices", {
      headers: RelayBearerRequestHeaders,
      success: RelayListDevicesResponseV1,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List registered iOS devices (legacy clients)"),
    HttpApiEndpoint.get("listDevicesV2", "/v2/client/devices", {
      headers: RelayBearerRequestHeaders,
      success: RelayListDevicesResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List registered mobile devices"),
    HttpApiEndpoint.post("linkEnvironment", "/v1/client/environment-links", {
      headers: RelayBearerRequestHeaders,
      payload: RelayEnvironmentLinkRequest,
      success: RelayEnvironmentLinkResponse,
      error: RelayEnvironmentLinkErrors,
    }).annotate(OpenApi.Summary, "Link an environment"),
    HttpApiEndpoint.post(
      "createEnvironmentLinkChallenge",
      "/v1/client/environment-link-challenges",
      {
        headers: RelayBearerRequestHeaders,
        payload: RelayEnvironmentLinkChallengeRequest,
        success: RelayEnvironmentLinkChallengeResponse,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Create an environment-link challenge"),
    HttpApiEndpoint.delete("unlinkEnvironment", "/v1/client/environment-links/:environmentId", {
      headers: RelayBearerRequestHeaders,
      params: RelayEnvironmentUnlinkParams,
      success: RelayOkResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Unlink an environment"),
    HttpApiEndpoint.delete(
      "releaseEnvironmentTunnel",
      "/v1/client/environment-links/:environmentId/tunnel",
      {
        headers: RelayBearerRequestHeaders,
        params: RelayEnvironmentUnlinkParams,
        success: RelayOkResponse,
        error: RelayAuthAndInternalErrors,
      },
    )
      .annotate(OpenApi.Summary, "Release an environment's managed tunnel")
      .annotate(
        OpenApi.Description,
        "Deletes the provisioned Cloudflare tunnel while keeping the environment link and its hostname reservation, so a later link re-provisions the tunnel under the same URL. Environments call this when they shut down; Cloudflare bills per provisioned tunnel, so idle tunnels should not outlive their environment.",
      ),
    HttpApiEndpoint.get("listOrgShareRequests", "/v1/org-share-requests", {
      headers: RelayBearerRequestHeaders,
      success: RelayOrgShareRequestListResponse,
      error: RelayOrgShareErrors,
    }).annotate(OpenApi.Summary, "List whole-organization shares waiting for an org owner"),
    HttpApiEndpoint.post("approveOrgShareRequest", "/v1/org-share-requests/:id/approve", {
      headers: RelayBearerRequestHeaders,
      params: Schema.Struct({ id: RelayOrgShareRequestId }),
      success: RelayOrgShareDecisionResponse,
      error: RelayOrgShareErrors,
    }).annotate(OpenApi.Summary, "Approve a whole-organization share"),
    HttpApiEndpoint.post("rejectOrgShareRequest", "/v1/org-share-requests/:id/reject", {
      headers: RelayBearerRequestHeaders,
      params: Schema.Struct({ id: RelayOrgShareRequestId }),
      success: RelayOrgShareDecisionResponse,
      error: RelayOrgShareErrors,
    }).annotate(OpenApi.Summary, "Reject a whole-organization share"),
    HttpApiEndpoint.get("previewThreadInvite", "/v1/thread-invites/:token", {
      headers: RelayBearerRequestHeaders,
      params: Schema.Struct({ token: RelayThreadInviteToken }),
      success: RelayThreadInvitePreview,
      error: RelayThreadInviteErrors,
    }).annotate(OpenApi.Summary, "Describe the thread an invite link shares"),
    HttpApiEndpoint.post("acceptThreadInvite", "/v1/thread-invites/:token/accept", {
      headers: RelayBearerRequestHeaders,
      params: Schema.Struct({ token: RelayThreadInviteToken }),
      success: RelayThreadInviteAcceptResponse,
      error: RelayThreadInviteErrors,
    }).annotate(OpenApi.Summary, "Join the thread an invite link shares"),
  )
  .annotate(OpenApi.Description, "Cloud-user environment links and registered devices.")
  .middleware(RelayClientAuth);

export const RelayExchangeDpopAccessTokenEndpoint = HttpApiEndpoint.post(
  "exchangeDpopAccessToken",
  "/v1/client/dpop-token",
  {
    headers: RelayDpopProofRequestHeaders,
    payload: RelayDpopAccessTokenRequest,
    success: RelayDpopAccessTokenResponse,
    error: RelayAuthAndInternalErrors,
  },
)
  .annotate(OpenApi.Summary, "Exchange a fwai gateway token for a DPoP access token")
  .annotate(
    OpenApi.Description,
    "Bootstrap endpoint. Send the DPoP proof JWT in the dpop header and the fwai gateway access token in subject_token. The returned access token is bound to the proof key.",
  );

const RelayTokenGroup = HttpApiGroup.make("token")
  .add(RelayExchangeDpopAccessTokenEndpoint)
  .annotate(OpenApi.Description, "OAuth token exchange for DPoP-bound client access.");

export const RelayConnectEnvironmentEndpoint = HttpApiEndpoint.post(
  "connectEnvironment",
  "/v1/environments/:environmentId/connect",
  {
    headers: RelayDpopRequestHeaders,
    params: Schema.Struct({
      environmentId: EnvironmentId,
    }),
    payload: RelayEnvironmentConnectRequest,
    success: RelayEnvironmentConnectResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, "Connect to an environment");

export const RelayGetEnvironmentStatusEndpoint = HttpApiEndpoint.post(
  "getEnvironmentStatus",
  "/v1/environments/:environmentId/status",
  {
    headers: RelayDpopRequestHeaders,
    params: Schema.Struct({
      environmentId: EnvironmentId,
    }),
    success: RelayEnvironmentStatusResponse,
    error: RelayEnvironmentConnectErrors,
  },
).annotate(OpenApi.Summary, "Check environment status");

export const RelayListSharedThreadsEndpoint = HttpApiEndpoint.get(
  "listSharedThreads",
  "/v1/shared-threads",
  {
    headers: RelayDpopRequestHeaders,
    success: RelaySharedThreadsResponse,
    error: RelayAuthAndInternalErrors,
  },
).annotate(OpenApi.Summary, "List threads other accounts shared with the caller");

/**
 * Share push channel (#20): `GET` with `Upgrade: websocket`, authenticated once at the upgrade with
 * the same DPoP access token (`environment:connect`) as `GET /v1/shared-threads`. Browsers cannot
 * set headers on a WebSocket, so the token and a proof for `GET https://<relay>/v1/shared-threads/events`
 * (no query) travel as query parameters. The socket carries only control hints, never content.
 */
export const RelaySharedThreadEventsPath = "/v1/shared-threads/events";
export const RelaySharedThreadEventsTokenParam = "access_token";
export const RelaySharedThreadEventsProofParam = "dpop";
/** Sent as text; the relay answers `pong` without waking the channel. */
export const RelaySharedThreadEventsPing = "ping";
export const RelaySharedThreadEventsPong = "pong";
/**
 * `shares-changed`: re-read `GET /v1/shared-threads`. `org-share-requests-changed`, sent only to
 * organization owners: re-read `GET /v1/org-share-requests`. Unknown messages are ignored.
 */
export const RelaySharedThreadEvent = Schema.Struct({
  type: Schema.Literals(["shares-changed", "org-share-requests-changed"]),
});
export type RelaySharedThreadEvent = typeof RelaySharedThreadEvent.Type;

const RelayAgentClientErrors = [
  RelayAuthInvalidError,
  RelayAgentRequestError,
  RelayInternalError,
] as const;
const RelayAgentRequestParams = Schema.Struct({ id: AgentRequestId });
const RelayAgentAccountParams = Schema.Struct({ accountId: AgentAccountId });

const RelayAgentClientEndpoints = [
  HttpApiEndpoint.get("getAgent", "/v1/agent", {
    headers: RelayDpopRequestHeaders,
    success: RelayAgentStateResponse,
    error: RelayAuthAndInternalErrors,
  }).annotate(OpenApi.Summary, "Read the caller's agent environment and blocked people"),
  HttpApiEndpoint.delete("disableAgent", "/v1/agent", {
    headers: RelayDpopRequestHeaders,
    success: RelayAgentStateResponse,
    error: RelayAuthAndInternalErrors,
  }).annotate(OpenApi.Summary, "Turn the caller's agent off"),
  HttpApiEndpoint.put("blockAgentSender", "/v1/agent/blocks/:accountId", {
    headers: RelayDpopRequestHeaders,
    params: RelayAgentAccountParams,
    success: RelayAgentStateResponse,
    error: RelayAuthAndInternalErrors,
  }).annotate(OpenApi.Summary, "Stop taking agent requests from a person"),
  HttpApiEndpoint.delete("unblockAgentSender", "/v1/agent/blocks/:accountId", {
    headers: RelayDpopRequestHeaders,
    params: RelayAgentAccountParams,
    success: RelayAgentStateResponse,
    error: RelayAuthAndInternalErrors,
  }).annotate(OpenApi.Summary, "Take agent requests from a person again"),
  HttpApiEndpoint.post("agentAvailability", "/v1/agent/availability", {
    headers: RelayDpopRequestHeaders,
    payload: RelayAgentAvailabilityRequest,
    success: RelayAgentAvailabilityResponse,
    error: RelayAuthAndInternalErrors,
  }).annotate(OpenApi.Summary, "Which colleagues can be asked"),
  HttpApiEndpoint.get("listAgentRequests", "/v1/agent-requests", {
    headers: RelayDpopRequestHeaders,
    success: RelayAgentRequestsResponse,
    error: RelayAuthAndInternalErrors,
  }).annotate(OpenApi.Summary, "List requests to and from the caller"),
  HttpApiEndpoint.post("decideAgentRequest", "/v1/agent-requests/:id/decision", {
    headers: RelayDpopRequestHeaders,
    params: RelayAgentRequestParams,
    payload: RelayAgentDecisionRequest,
    success: RelayAgentRequestResponse,
    error: RelayAgentClientErrors,
  }).annotate(OpenApi.Summary, "Accept, forward or reject a request to the caller's agent"),
  HttpApiEndpoint.post("cancelAgentRequest", "/v1/agent-requests/:id/cancel", {
    headers: RelayDpopRequestHeaders,
    params: RelayAgentRequestParams,
    success: RelayAgentRequestResponse,
    error: RelayAgentClientErrors,
  }).annotate(OpenApi.Summary, "Withdraw a pending request the caller sent"),
] as const;

const RelayDpopClientGroup = HttpApiGroup.make("dpopClient")
  .add(
    RelayConnectEnvironmentEndpoint,
    RelayGetEnvironmentStatusEndpoint,
    RelayListSharedThreadsEndpoint,
    ...RelayAgentClientEndpoints,
  )
  .annotate(OpenApi.Description, "DPoP-authenticated client access to linked environments.")
  .middleware(RelayDpopClientAuth);

export const RelayEnvironmentLinkPreferencesRequest = Schema.Struct({
  holdWebhooksWhileOffline: Schema.Boolean,
});
export type RelayEnvironmentLinkPreferencesRequest =
  typeof RelayEnvironmentLinkPreferencesRequest.Type;

export const RelayWakeHeldHooksResponse = Schema.Struct({
  pending: Schema.Boolean,
});
export type RelayWakeHeldHooksResponse = typeof RelayWakeHeldHooksResponse.Type;

const RelayServerGroup = HttpApiGroup.make("server")
  .add(
    HttpApiEndpoint.post(
      "registerManagedEndpointRecovery",
      "/v1/environments/:environmentId/tunnel/recovery",
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
        }),
        payload: RelayManagedEndpointRecoveryRegistrationRequest,
        success: RelayManagedEndpointRecoveryRegistrationResponse,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Register managed tunnel recovery without provisioning"),
    HttpApiEndpoint.post("recoverManagedEndpoint", "/v1/environments/:environmentId/tunnel", {
      params: Schema.Struct({
        environmentId: EnvironmentId,
      }),
      payload: RelayManagedEndpointRecoveryRequest,
      success: RelayManagedEndpointRecoveryResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Recover an environment's managed tunnel"),
    HttpApiEndpoint.post(
      "publishAgentActivity",
      "/v1/environments/:environmentId/threads/:threadId/agent-activity",
      {
        params: Schema.Struct({
          environmentId: EnvironmentId,
          threadId: ThreadId,
        }),
        payload: RelayAgentActivityPublishRequest,
        success: RelayPublishResponse,
        error: RelayAgentActivityPublishErrors,
      },
    ).annotate(OpenApi.Summary, "Publish agent activity"),
    HttpApiEndpoint.post(
      "updateLinkPreferences",
      "/v1/environments/:environmentId/link-preferences",
      {
        params: Schema.Struct({ environmentId: EnvironmentId }),
        payload: RelayEnvironmentLinkPreferencesRequest,
        success: RelayEnvironmentLinkPreferencesRequest,
        error: RelayAuthAndInternalErrors,
      },
    ).annotate(OpenApi.Summary, "Update an environment's link preferences"),
    HttpApiEndpoint.put("syncThreadGrants", "/v1/environment/thread-grants/:threadId", {
      params: Schema.Struct({ threadId: ThreadId }),
      payload: RelayThreadGrantSyncRequest,
      success: RelayThreadGrantSyncResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Replace a thread's share grants"),
    HttpApiEndpoint.get("listThreadGrants", "/v1/environment/thread-grants", {
      success: RelayThreadGrantListResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List the status of every share grant of this environment"),
    HttpApiEndpoint.post("sendLinkEnvelope", "/v1/environment/link-envelopes", {
      payload: RelayLinkEnvelope,
      success: RelayLinkSendResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Forward a linked-thread envelope to another environment"),
    HttpApiEndpoint.post("linkPresence", "/v1/environment/link-presence", {
      payload: RelayLinkPresenceRequest,
      success: RelayLinkPresenceResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Whether linked threads in other environments are reachable"),
    HttpApiEndpoint.put("setAgentEnvironment", "/v1/environment/agent", {
      payload: RelayAgentEnableRequest,
      success: RelayAgentRecordResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Make this environment the account's agent environment, or stop"),
    HttpApiEndpoint.post("createAgentRequest", "/v1/environment/agent-requests", {
      payload: RelayAgentCreateRequest,
      success: RelayAgentCreateResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Ask a colleague's agent from one of this environment's threads"),
    HttpApiEndpoint.get("listAgentColleagues", "/v1/environment/agent-colleagues", {
      success: RelayAgentColleaguesResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "List colleagues whose agents the owner can ask"),
    HttpApiEndpoint.get("syncAgentRequests", "/v1/environment/agent-requests", {
      success: RelayAgentSyncResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(OpenApi.Summary, "Read this environment's agent inbox and sent requests"),
    HttpApiEndpoint.get("listPriorAgentRequests", "/v1/environment/agent-requests/:id/prior", {
      params: Schema.Struct({ id: AgentRequestId }),
      success: RelayAgentPriorRequestsResponse,
      error: [RelayAuthInvalidError, RelayAgentRequestError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Read the same sender's earlier requests to the owner"),
    HttpApiEndpoint.post("proposeAgentRequest", "/v1/environment/agent-requests/:id/proposal", {
      params: Schema.Struct({ id: AgentRequestId }),
      payload: RelayAgentProposalRequest,
      success: RelayAgentRequestResponse,
      error: [RelayAuthInvalidError, RelayAgentRequestError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Fill a request's approval card with the agent's proposal"),
    HttpApiEndpoint.post(
      "decideAgentRequestByRules",
      "/v1/environment/agent-requests/:id/rule-decision",
      {
        params: Schema.Struct({ id: AgentRequestId }),
        payload: RelayAgentRuleDecisionRequest,
        success: RelayAgentRequestResponse,
        error: [RelayAuthInvalidError, RelayAgentRequestError, RelayInternalError],
      },
    ).annotate(OpenApi.Summary, "Accept what the owner's grants approve without asking"),
    HttpApiEndpoint.post("reportAgentExecution", "/v1/environment/agent-requests/:id/execution", {
      params: Schema.Struct({ id: AgentRequestId }),
      payload: RelayAgentExecutionRequest,
      success: RelayAgentRequestResponse,
      error: [RelayAuthInvalidError, RelayAgentRequestError, RelayInternalError],
    }).annotate(OpenApi.Summary, "Report how an accepted action ran"),
    HttpApiEndpoint.post("wakeHeldHooks", "/v1/environments/:environmentId/hooks/wake", {
      params: Schema.Struct({ environmentId: EnvironmentId }),
      success: RelayWakeHeldHooksResponse,
      error: RelayAuthAndInternalErrors,
    }).annotate(
      OpenApi.Summary,
      "Deliver webhook requests held while the environment was offline now",
    ),
  )
  .annotate(OpenApi.Description, "Environment-authenticated activity publication.")
  .middleware(RelayEnvironmentAuth);

// Path token authenticates; forward raw bytes for signature verification.
// endpointKey is the managed endpoint hash, not the account-linkable environment id.
const RelayHookParams = Schema.Struct({
  endpointKey: Schema.String,
  hookId: Schema.String,
  token: Schema.String,
});
const RELAY_HOOK_PATH = "/v1/hooks/:endpointKey/:hookId/:token";
const relayHookEndpoint = { params: RelayHookParams } as const;
const RelayHooksGroup = HttpApiGroup.make("hooks")
  .add(
    HttpApiEndpoint.post("forwardPost", RELAY_HOOK_PATH, relayHookEndpoint),
    HttpApiEndpoint.put("forwardPut", RELAY_HOOK_PATH, relayHookEndpoint),
    HttpApiEndpoint.patch("forwardPatch", RELAY_HOOK_PATH, relayHookEndpoint),
    HttpApiEndpoint.get("forwardGet", RELAY_HOOK_PATH, relayHookEndpoint),
  )
  .annotate(OpenApi.Description, "Forward webhook requests to an environment.");

export const RelayApi = HttpApi.make("RelayApi")
  .add(
    RelayHealthGroup,
    RelayMetadataGroup,
    RelayMobileGroup,
    RelayClientGroup,
    RelayTokenGroup,
    RelayDpopClientGroup,
    RelayServerGroup,
    RelayHooksGroup,
  )
  .annotate(OpenApi.Title, "fwai Relay API")
  .annotate(OpenApi.Version, "1.0.0")
  .annotate(
    OpenApi.Description,
    "Control-plane API for linking fwai environments, connecting authorized clients, and publishing agent activity.",
  );
export type RelayApi = typeof RelayApi;
