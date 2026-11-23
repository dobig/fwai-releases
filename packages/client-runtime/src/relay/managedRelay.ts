import {
  RelayAccessTokenType,
  RelayApi,
  type RelayClientEnvironmentRecord,
  type RelayClientDeviceRecord,
  RelayConnectEnvironmentEndpoint,
  type RelayDeviceRegistrationRequest,
  RelayDpopAccessTokenScope,
  RelayDpopTokenExchangeGrantType,
  RelayEnvironmentConnectScope,
  type RelayEnvironmentConnectRequest,
  type RelayEnvironmentConnectResponse,
  type RelayEnvironmentLinkChallengeRequest,
  type RelayEnvironmentLinkChallengeResponse,
  type RelayEnvironmentLinkRequest,
  type RelayEnvironmentLinkResponse,
  type RelayEnvironmentStatusResponse,
  RelayExchangeDpopAccessTokenEndpoint,
  RelayGetEnvironmentStatusEndpoint,
  RelayListSharedThreadsEndpoint,
  RelaySharedThreadEventsPath,
  RelaySharedThreadEventsProofParam,
  RelaySharedThreadEventsTokenParam,
  type RelayOrgShareDecisionResponse,
  type RelayOrgShareNotAuthorizedError,
  type RelayOrgShareRequestNotFoundError,
  type RelayOrgShareRequest,
  type RelaySharedThread,
  type RelayThreadInviteAcceptResponse,
  type RelayThreadInviteRateLimitedError,
  type RelayThreadInvitePreview,
  type RelayAgentRequestError,
  type RelayAgentRequestsResponse,
  type RelayAgentStateResponse,
  RelayJwtSubjectTokenType,
  type RelayAgentActivitySnapshotResponse,
  type RelayLiveActivityRegistrationRequest,
  RelayMobileRegistrationScope,
  type RelayOkResponse,
  type RelayPublicClientId,
  RelayRegisterDeviceEndpoint,
  RelayAgentActivitySnapshotEndpoint,
  RelayRegisterLiveActivityEndpoint,
  RelayProtectedError,
  type RelayProtectedError as RelayProtectedErrorType,
  RelayUnregisterDeviceEndpoint,
} from "@t3tools/contracts/relay";
import { AgentRequestId, type AgentDecision, type AgentRequest } from "@t3tools/contracts";
import { encodeOAuthScope, oauthScopeSetEquals } from "@t3tools/shared/oauthScope";
import { decodeRelayJwt } from "@t3tools/shared/relayJwt";
import { withRelayClientTracing } from "@t3tools/shared/relayTracing";
import { normalizeSecureRelayUrl } from "@t3tools/shared/relayUrl";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import * as HttpClientError from "effect/http/HttpClientError";
import type * as HttpMethod from "effect/http/HttpMethod";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";

export interface ManagedRelayDpopProofInput {
  readonly method: HttpMethod.HttpMethod;
  readonly url: string;
  readonly accessToken?: string;
}

export class ManagedRelayDpopKeyLoadError extends Schema.TaggedError<ManagedRelayDpopKeyLoadError>()(
  "ManagedRelayDpopKeyLoadError",
  {
    keyStore: Schema.Literals(["expo-secure-store", "indexed-db"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not load relay DPoP proof key.";
  }
}

export class ManagedRelayDpopProofCreationError extends Schema.TaggedError<ManagedRelayDpopProofCreationError>()(
  "ManagedRelayDpopProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not create the relay DPoP proof for ${this.method} ${this.url}.`;
  }
}

export const ManagedRelayDpopSignerError = Schema.Union([
  ManagedRelayDpopKeyLoadError,
  ManagedRelayDpopProofCreationError,
]);
export type ManagedRelayDpopSignerError = typeof ManagedRelayDpopSignerError.Type;

export const ManagedRelayRequestAction = Schema.Literals([
  "exchange relay DPoP access token",
  "list relay-managed environments",
  "list relay client devices",
  "create relay environment link challenge",
  "link relay environment",
  "unlink relay environment",
  "get relay environment status",
  "connect relay environment",
  "register relay mobile device",
  "unregister relay mobile device",
  "register relay live activity",
  "read relay agent activity snapshot",
  "list relay shared threads",
  "list relay organization share requests",
  "decide relay organization share request",
  "call relay personal agent",
  "open relay thread invite",
]);
export type ManagedRelayRequestAction = typeof ManagedRelayRequestAction.Type;

export const ManagedRelayRequestActivity = Schema.Literals([
  "Relay DPoP access token exchange",
  "Relay environment listing",
  "Relay client device listing",
  "Relay environment link challenge",
  "Relay environment linking",
  "Relay environment unlinking",
  "Relay environment status request",
  "Relay environment connection",
  "Relay mobile device registration",
  "Relay mobile device unregistration",
  "Relay Live Activity registration",
  "Relay agent activity snapshot",
  "Relay shared thread listing",
  "Relay organization share request listing",
  "Relay organization share decision",
  "Relay personal agent call",
  "Relay thread invite",
]);
export type ManagedRelayRequestActivity = typeof ManagedRelayRequestActivity.Type;

export class ManagedRelayRequestTimeoutError extends Schema.TaggedError<ManagedRelayRequestTimeoutError>()(
  "ManagedRelayRequestTimeoutError",
  {
    activity: ManagedRelayRequestActivity,
    timeoutMs: Schema.Number,
    traceId: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `${this.activity} timed out. ${NETWORK_BLOCKING_HINT}`;
  }
}

export class ManagedRelayUrlInvalidError extends Schema.TaggedError<ManagedRelayUrlInvalidError>()(
  "ManagedRelayUrlInvalidError",
  {
    relayUrl: Schema.String,
  },
) {
  override get message(): string {
    return "Relay URL must be a secure absolute HTTPS origin.";
  }
}

export class ManagedRelayRequestFailedError extends Schema.TaggedError<ManagedRelayRequestFailedError>()(
  "ManagedRelayRequestFailedError",
  {
    action: ManagedRelayRequestAction,
    transportFailed: Schema.optionalKey(Schema.Boolean),
    cause: Schema.Defect(),
    relayError: Schema.optional(RelayProtectedError),
    status: Schema.optional(Schema.Number),
    traceId: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const message = `Could not ${this.action}.`;
    return this.transportFailed ? `${message} ${NETWORK_BLOCKING_HINT}` : message;
  }
}

export class ManagedRelayAccessTokenScopesUnexpectedError extends Schema.TaggedError<ManagedRelayAccessTokenScopesUnexpectedError>()(
  "ManagedRelayAccessTokenScopesUnexpectedError",
  {
    requestedScopes: Schema.Array(RelayDpopAccessTokenScope),
    grantedScope: Schema.String,
  },
) {
  override get message(): string {
    return "Relay granted unexpected DPoP access token scopes.";
  }
}

export class ManagedRelayTokenProofCreationError extends Schema.TaggedError<ManagedRelayTokenProofCreationError>()(
  "ManagedRelayTokenProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create relay token DPoP proof.";
  }
}

export class ManagedRelayRequestProofCreationError extends Schema.TaggedError<ManagedRelayRequestProofCreationError>()(
  "ManagedRelayRequestProofCreationError",
  {
    method: Schema.String,
    url: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "Could not create relay request DPoP proof.";
  }
}

export const ManagedRelayClientError = Schema.Union([
  ManagedRelayUrlInvalidError,
  ManagedRelayRequestFailedError,
  ManagedRelayRequestTimeoutError,
  ManagedRelayAccessTokenScopesUnexpectedError,
  ManagedRelayDpopKeyLoadError,
  ManagedRelayTokenProofCreationError,
  ManagedRelayRequestProofCreationError,
]);
export type ManagedRelayClientError = typeof ManagedRelayClientError.Type;

type RelayHttpRequestError =
  | RelayProtectedErrorType
  | RelayOrgShareNotAuthorizedError
  | RelayOrgShareRequestNotFoundError
  | RelayAgentRequestError
  | RelayThreadInviteRateLimitedError
  | HttpClientError.HttpClientError
  | Schema.SchemaError;

export class ManagedRelayDpopSigner extends Context.Service<
  ManagedRelayDpopSigner,
  {
    readonly thumbprint: Effect.Effect<string, ManagedRelayDpopKeyLoadError>;
    readonly createProof: (
      input: ManagedRelayDpopProofInput,
    ) => Effect.Effect<string, ManagedRelayDpopProofCreationError>;
  }
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayDpopSigner") {}

export const MANAGED_RELAY_REQUEST_TIMEOUT_MS = 10_000;

export interface ManagedRelayAccessTokenCacheEntry {
  readonly accountId: string;
  readonly clientId: RelayPublicClientId;
  readonly relayUrl: string;
  readonly thumbprint: string;
  readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
  readonly accessToken: string;
  readonly expiresAtMillis: number;
}

export interface ManagedRelayAccessTokenStore {
  readonly load: Effect.Effect<ReadonlyArray<ManagedRelayAccessTokenCacheEntry>>;
  readonly save: (entries: ReadonlyArray<ManagedRelayAccessTokenCacheEntry>) => Effect.Effect<void>;
  readonly clear: Effect.Effect<void>;
}

export interface ManagedRelayAuthorization {
  readonly accessToken: string;
  readonly proof: string;
  readonly thumbprint: string;
}

export interface ManagedRelayClientLayerOptions {
  readonly relayUrl: string;
  readonly clientId: RelayPublicClientId;
  readonly accessTokenStore?: ManagedRelayAccessTokenStore;
}

export class ManagedRelayClient extends Context.Service<
  ManagedRelayClient,
  {
    readonly relayUrl: string;
    readonly listEnvironments: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayClientEnvironmentRecord>, ManagedRelayClientError>;
    readonly listDevices: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayClientDeviceRecord>, ManagedRelayClientError>;
    readonly createEnvironmentLinkChallenge: (input: {
      readonly accountToken: string;
      readonly payload: RelayEnvironmentLinkChallengeRequest;
    }) => Effect.Effect<RelayEnvironmentLinkChallengeResponse, ManagedRelayClientError>;
    readonly linkEnvironment: (input: {
      readonly accountToken: string;
      readonly payload: RelayEnvironmentLinkRequest;
    }) => Effect.Effect<RelayEnvironmentLinkResponse, ManagedRelayClientError>;
    readonly unlinkEnvironment: (input: {
      readonly accountToken: string;
      readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly getEnvironmentStatus: (input: {
      readonly accountToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
    }) => Effect.Effect<RelayEnvironmentStatusResponse, ManagedRelayClientError>;
    readonly connectEnvironment: (input: {
      readonly accountToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly environmentId: RelayClientEnvironmentRecord["environmentId"];
      readonly deviceId?: string;
    }) => Effect.Effect<RelayEnvironmentConnectResponse, ManagedRelayClientError>;
    readonly registerDevice: (input: {
      readonly accountToken: string;
      readonly payload: RelayDeviceRegistrationRequest;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly unregisterDevice: (input: {
      readonly accountToken: string;
      readonly deviceId: string;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly registerLiveActivity: (input: {
      readonly accountToken: string;
      readonly payload: RelayLiveActivityRegistrationRequest;
    }) => Effect.Effect<RelayOkResponse, ManagedRelayClientError>;
    readonly getAgentActivitySnapshot: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<RelayAgentActivitySnapshotResponse, ManagedRelayClientError>;
    /** Threads other accounts shared with this account (#20). */
    readonly listSharedThreads: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<ReadonlyArray<RelaySharedThread>, ManagedRelayClientError>;
    /**
     * A `wss:` URL for the share push channel (#20), carrying a fresh DPoP proof; good for one
     * connection attempt.
     */
    readonly authorizeSharedThreadEvents: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<string, ManagedRelayClientError>;
    /**
     * A DPoP access token and a fresh proof for one call to the relay's voice routes
     * (`/v1/voice/*`); the voice brain on the phone sends Doubao requests through them.
     */
    readonly authorizeVoice: (input: {
      readonly accountToken: string;
      readonly method: "GET" | "POST";
      readonly url: string;
    }) => Effect.Effect<ManagedRelayAuthorization, ManagedRelayClientError>;
    /** Whole-organization shares waiting for an org owner; fails with 403 for anyone else. */
    readonly listOrgShareRequests: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<ReadonlyArray<RelayOrgShareRequest>, ManagedRelayClientError>;
    readonly decideOrgShareRequest: (input: {
      readonly accountToken: string;
      readonly requestId: string;
      readonly decision: "approve" | "reject";
    }) => Effect.Effect<RelayOrgShareDecisionResponse, ManagedRelayClientError>;
    /** Invite links (#58). Null when the link does not work, whatever the reason. */
    readonly previewThreadInvite: (input: {
      readonly accountToken: string;
      readonly token: string;
    }) => Effect.Effect<RelayThreadInvitePreview | null, ManagedRelayClientError>;
    readonly acceptThreadInvite: (input: {
      readonly accountToken: string;
      readonly token: string;
    }) => Effect.Effect<RelayThreadInviteAcceptResponse | null, ManagedRelayClientError>;
    /** Personal agent (#22): the caller's agent environment and blocked people. */
    readonly getAgent: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<RelayAgentStateResponse, ManagedRelayClientError>;
    readonly disableAgent: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<RelayAgentStateResponse, ManagedRelayClientError>;
    readonly setAgentBlocked: (input: {
      readonly accountToken: string;
      readonly accountId: string;
      readonly blocked: boolean;
    }) => Effect.Effect<RelayAgentStateResponse, ManagedRelayClientError>;
    readonly agentAvailability: (input: {
      readonly accountToken: string;
      readonly accountIds: ReadonlyArray<string>;
    }) => Effect.Effect<ReadonlyArray<string>, ManagedRelayClientError>;
    readonly listAgentRequests: (input: {
      readonly accountToken: string;
    }) => Effect.Effect<RelayAgentRequestsResponse, ManagedRelayClientError>;
    readonly decideAgentRequest: (input: {
      readonly accountToken: string;
      readonly requestId: string;
      readonly decision: AgentDecision;
    }) => Effect.Effect<AgentRequest, ManagedRelayClientError>;
    readonly cancelAgentRequest: (input: {
      readonly accountToken: string;
      readonly requestId: string;
    }) => Effect.Effect<AgentRequest, ManagedRelayClientError>;
    readonly resetTokenCache: Effect.Effect<void>;
  }
>()("@t3tools/client-runtime/relay/managedRelay/ManagedRelayClient") {}

const isRelayProtectedError = Schema.is(RelayProtectedError);

const TRACEPARENT_TRACE_ID = /^[\da-f]{2}-([\da-f]{32})-[\da-f]{16}-[\da-f]{2}$/i;

function untypedResponseFields(cause: RelayHttpRequestError) {
  const response = HttpClientError.isHttpClientError(cause) ? cause.response : undefined;
  if (!response) return {};
  const traceId = TRACEPARENT_TRACE_ID.exec(response.headers.traceparent ?? "")?.[1];
  return { status: response.status, ...(traceId ? { traceId } : {}) };
}

function relayRequestError(action: ManagedRelayRequestAction) {
  return (cause: RelayHttpRequestError): ManagedRelayClientError =>
    new ManagedRelayRequestFailedError({
      action,
      transportFailed:
        HttpClientError.isHttpClientError(cause) && cause.reason._tag === "TransportError",
      cause,
      ...(isRelayProtectedError(cause)
        ? { relayError: cause, traceId: cause.traceId }
        : untypedResponseFields(cause)),
    });
}

function proofCreationErrorFields(error: ManagedRelayDpopProofCreationError) {
  return {
    method: error.method,
    url: error.url,
    cause: error,
  };
}

function isRejectedDpopAccessToken(error: ManagedRelayClientError): boolean {
  return (
    error._tag === "ManagedRelayRequestFailedError" &&
    error.relayError?._tag === "RelayAuthInvalidError" &&
    error.relayError.reason === "invalid_bearer"
  );
}

function timeoutRelayRequest(activity: ManagedRelayRequestActivity) {
  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, E | ManagedRelayClientError, R> =>
    effect.pipe(
      Effect.timeoutOption(Duration.millis(MANAGED_RELAY_REQUEST_TIMEOUT_MS)),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.currentParentSpan.pipe(
              Effect.map((span) => span.traceId),
              Effect.orElseSucceed(() => null),
              Effect.flatMap((traceId) =>
                Effect.fail(
                  new ManagedRelayRequestTimeoutError({
                    activity,
                    timeoutMs: MANAGED_RELAY_REQUEST_TIMEOUT_MS,
                    traceId,
                  }),
                ),
              ),
            ),
          onSome: Effect.succeed,
        }),
      ),
    );
}

function tokenMatches(
  token: ManagedRelayAccessTokenCacheEntry,
  input: {
    readonly accountId: string;
    readonly clientId: RelayPublicClientId;
    readonly relayUrl: string;
    readonly thumbprint: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly nowMillis: number;
  },
): boolean {
  return (
    token.accountId === input.accountId &&
    token.clientId === input.clientId &&
    token.relayUrl === input.relayUrl &&
    token.thumbprint === input.thumbprint &&
    token.expiresAtMillis > input.nowMillis + 5_000 &&
    input.scopes.every((scope) => token.scopes.includes(scope))
  );
}

function relayAccountId(accountToken: string): Option.Option<string> {
  try {
    return Option.fromNullishOr(decodeRelayJwt(accountToken).sub).pipe(
      Option.filter((subject) => subject.length > 0),
    );
  } catch {
    return Option.none();
  }
}

function bearerHeaders(accountToken: string) {
  return { authorization: `Bearer ${accountToken}` };
}

function dpopHeaders(authorization: ManagedRelayAuthorization) {
  return {
    authorization: `DPoP ${authorization.accessToken}`,
    dpop: authorization.proof,
  };
}

function disabledManagedRelayClient(relayUrl: string): ManagedRelayClient["Service"] {
  const unavailable = (spanName: string) =>
    Effect.fn(spanName)(function* () {
      return yield* new ManagedRelayUrlInvalidError({ relayUrl });
    });
  return ManagedRelayClient.of({
    relayUrl,
    listEnvironments: unavailable("clientRuntime.managedRelay.listEnvironments"),
    listDevices: unavailable("clientRuntime.managedRelay.listDevices"),
    createEnvironmentLinkChallenge: unavailable(
      "clientRuntime.managedRelay.createEnvironmentLinkChallenge",
    ),
    linkEnvironment: unavailable("clientRuntime.managedRelay.linkEnvironment"),
    unlinkEnvironment: unavailable("clientRuntime.managedRelay.unlinkEnvironment"),
    getEnvironmentStatus: unavailable("clientRuntime.managedRelay.getEnvironmentStatus"),
    connectEnvironment: unavailable("clientRuntime.managedRelay.connectEnvironment"),
    registerDevice: unavailable("clientRuntime.managedRelay.registerDevice"),
    unregisterDevice: unavailable("clientRuntime.managedRelay.unregisterDevice"),
    registerLiveActivity: unavailable("clientRuntime.managedRelay.registerLiveActivity"),
    getAgentActivitySnapshot: unavailable("clientRuntime.managedRelay.getAgentActivitySnapshot"),
    listSharedThreads: unavailable("clientRuntime.managedRelay.listSharedThreads"),
    authorizeSharedThreadEvents: unavailable(
      "clientRuntime.managedRelay.authorizeSharedThreadEvents",
    ),
    authorizeVoice: unavailable("clientRuntime.managedRelay.authorizeVoice"),
    listOrgShareRequests: unavailable("clientRuntime.managedRelay.listOrgShareRequests"),
    previewThreadInvite: unavailable("clientRuntime.managedRelay.previewThreadInvite"),
    acceptThreadInvite: unavailable("clientRuntime.managedRelay.acceptThreadInvite"),
    decideOrgShareRequest: unavailable("clientRuntime.managedRelay.decideOrgShareRequest"),
    getAgent: unavailable("clientRuntime.managedRelay.getAgent"),
    disableAgent: unavailable("clientRuntime.managedRelay.disableAgent"),
    setAgentBlocked: unavailable("clientRuntime.managedRelay.setAgentBlocked"),
    agentAvailability: unavailable("clientRuntime.managedRelay.agentAvailability"),
    listAgentRequests: unavailable("clientRuntime.managedRelay.listAgentRequests"),
    decideAgentRequest: unavailable("clientRuntime.managedRelay.decideAgentRequest"),
    cancelAgentRequest: unavailable("clientRuntime.managedRelay.cancelAgentRequest"),
    resetTokenCache: Effect.void.pipe(
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
    ),
  });
}

/** @public */
export const make = Effect.fn("ManagedRelayClient.make")(function* (
  options: ManagedRelayClientLayerOptions,
) {
  const relayUrl = normalizeSecureRelayUrl(options.relayUrl);
  if (relayUrl === null) {
    return disabledManagedRelayClient(options.relayUrl);
  }
  const signer = yield* ManagedRelayDpopSigner;
  const client = yield* HttpApiClient.make(RelayApi, { baseUrl: relayUrl });
  const initialTokens = options.accessTokenStore ? yield* options.accessTokenStore.load : [];
  const cachedTokens = yield* SynchronizedRef.make<
    ReadonlyArray<ManagedRelayAccessTokenCacheEntry>
  >(initialTokens.filter((token) => token.clientId === options.clientId));
  const urlBuilder = HttpApiClient.urlBuilder(RelayApi, { baseUrl: relayUrl });

  type DpopProofTarget = Pick<ManagedRelayDpopProofInput, "method" | "url">;
  const dpopProofTargets = {
    exchangeAccessToken: (): DpopProofTarget => ({
      method: RelayExchangeDpopAccessTokenEndpoint.method,
      url: urlBuilder.token.exchangeDpopAccessToken(),
    }),
    getEnvironmentStatus: (
      environmentId: RelayClientEnvironmentRecord["environmentId"],
    ): DpopProofTarget => ({
      method: RelayGetEnvironmentStatusEndpoint.method,
      url: urlBuilder.dpopClient.getEnvironmentStatus({ params: { environmentId } }),
    }),
    connectEnvironment: (
      environmentId: RelayClientEnvironmentRecord["environmentId"],
    ): DpopProofTarget => ({
      method: RelayConnectEnvironmentEndpoint.method,
      url: urlBuilder.dpopClient.connectEnvironment({ params: { environmentId } }),
    }),
    registerDevice: (): DpopProofTarget => ({
      method: RelayRegisterDeviceEndpoint.method,
      url: urlBuilder.mobile.registerDevice(),
    }),
    unregisterDevice: (deviceId: string): DpopProofTarget => ({
      method: RelayUnregisterDeviceEndpoint.method,
      url: urlBuilder.mobile.unregisterDevice({ params: { deviceId } }),
    }),
    getAgentActivitySnapshot: (): DpopProofTarget => ({
      method: RelayAgentActivitySnapshotEndpoint.method,
      url: urlBuilder.mobile.getAgentActivitySnapshot(),
    }),
    registerLiveActivity: (): DpopProofTarget => ({
      method: RelayRegisterLiveActivityEndpoint.method,
      url: urlBuilder.mobile.registerLiveActivity(),
    }),
    listSharedThreads: (): DpopProofTarget => ({
      method: RelayListSharedThreadsEndpoint.method,
      url: urlBuilder.dpopClient.listSharedThreads(),
    }),
    sharedThreadEvents: (): DpopProofTarget => ({
      method: "GET",
      url: new URL(RelaySharedThreadEventsPath, relayUrl).href,
    }),
  };

  const exchangeAccessToken = Effect.fn("clientRuntime.managedRelay.exchangeAccessToken")(
    function* (input: {
      readonly accountToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    }) {
      yield* Effect.annotateCurrentSpan({
        "relay.client_id": options.clientId,
        "relay.scopes": input.scopes.join(" "),
      });
      const proof = yield* signer
        .createProof(dpopProofTargets.exchangeAccessToken())
        .pipe(
          Effect.mapError(
            (error) => new ManagedRelayTokenProofCreationError(proofCreationErrorFields(error)),
          ),
        );
      const response = yield* client.token
        .exchangeDpopAccessToken({
          headers: { dpop: proof },
          payload: {
            grant_type: RelayDpopTokenExchangeGrantType,
            subject_token: input.accountToken,
            subject_token_type: RelayJwtSubjectTokenType,
            requested_token_type: RelayAccessTokenType,
            resource: relayUrl,
            scope: encodeOAuthScope(input.scopes),
            client_id: options.clientId,
          },
        })
        .pipe(
          Effect.mapError(relayRequestError("exchange relay DPoP access token")),
          timeoutRelayRequest("Relay DPoP access token exchange"),
        );
      if (!oauthScopeSetEquals(response.scope, input.scopes)) {
        return yield* new ManagedRelayAccessTokenScopesUnexpectedError({
          requestedScopes: input.scopes,
          grantedScope: response.scope,
        });
      }
      return response;
    },
  );

  const obtainAccessToken = Effect.fn("clientRuntime.managedRelay.obtainAccessToken")(
    function* (input: {
      readonly accountToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly thumbprint: string;
    }) {
      yield* Effect.annotateCurrentSpan({
        "relay.client_id": options.clientId,
        "relay.scopes": input.scopes.join(" "),
      });
      const nowMillis = yield* Clock.currentTimeMillis;
      const accountId = relayAccountId(input.accountToken);
      if (Option.isNone(accountId)) {
        yield* Effect.annotateCurrentSpan({
          "relay.token_cache.result": "bypass",
          "relay.token_cache.bypass_reason": "invalid_subject_token",
        });
        const response = yield* exchangeAccessToken(input);
        return {
          accountId: "",
          clientId: options.clientId,
          relayUrl,
          thumbprint: input.thumbprint,
          scopes: input.scopes,
          accessToken: response.access_token,
          expiresAtMillis: nowMillis + response.expires_in * 1_000,
        } satisfies ManagedRelayAccessTokenCacheEntry;
      }
      const match = {
        accountId: accountId.value,
        clientId: options.clientId,
        relayUrl,
        thumbprint: input.thumbprint,
        scopes: input.scopes,
        nowMillis,
      };
      const cached = (yield* SynchronizedRef.get(cachedTokens)).find((token) =>
        tokenMatches(token, match),
      );
      if (cached) {
        yield* Effect.annotateCurrentSpan({
          "relay.token_cache.result": "hit",
        });
        return cached;
      }
      return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) =>
        Effect.gen(function* () {
          const lookupMillis = yield* Clock.currentTimeMillis;
          const activeTokens = tokens.filter(
            (token) => token.expiresAtMillis > lookupMillis + 5_000,
          );
          const cached = activeTokens.find((token) =>
            tokenMatches(token, { ...match, nowMillis: lookupMillis }),
          );
          if (cached) {
            yield* Effect.annotateCurrentSpan({
              "relay.token_cache.result": "hit",
            });
            return [cached, activeTokens] as const;
          }
          yield* Effect.annotateCurrentSpan({
            "relay.token_cache.result": "miss",
          });
          const response = yield* exchangeAccessToken(input);
          const next: ManagedRelayAccessTokenCacheEntry = {
            accountId: accountId.value,
            clientId: options.clientId,
            relayUrl,
            thumbprint: input.thumbprint,
            scopes: input.scopes,
            accessToken: response.access_token,
            expiresAtMillis: lookupMillis + response.expires_in * 1_000,
          };
          const nextTokens = [...activeTokens, next];
          if (options.accessTokenStore) {
            yield* options.accessTokenStore.save(nextTokens);
          }
          return [next, nextTokens] as const;
        }),
      ).pipe(Effect.withSpan("clientRuntime.managedRelay.tokenCacheCriticalSection"));
    },
  );

  const authorize = Effect.fn("clientRuntime.managedRelay.authorize")(function* (input: {
    readonly accountToken: string;
    readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    readonly target: DpopProofTarget;
  }) {
    yield* Effect.annotateCurrentSpan({
      "relay.client_id": options.clientId,
      "relay.scopes": input.scopes.join(" "),
      "http.request.method": input.target.method,
      "url.full": input.target.url,
    });
    const thumbprint = yield* signer.thumbprint;
    const token = yield* obtainAccessToken({
      accountToken: input.accountToken,
      scopes: input.scopes,
      thumbprint,
    });
    const proof = yield* signer
      .createProof({
        ...input.target,
        accessToken: token.accessToken,
      })
      .pipe(
        Effect.mapError(
          (error) => new ManagedRelayRequestProofCreationError(proofCreationErrorFields(error)),
        ),
      );
    return { accessToken: token.accessToken, proof, thumbprint };
  });

  const invalidateAccessToken = Effect.fn("clientRuntime.managedRelay.invalidateAccessToken")(
    function* (accessToken: string) {
      return yield* SynchronizedRef.modifyEffect(cachedTokens, (tokens) => {
        const nextTokens = tokens.filter((token) => token.accessToken !== accessToken);
        if (nextTokens.length === tokens.length) {
          return Effect.succeed([false, tokens] as const);
        }
        return (
          options.accessTokenStore ? options.accessTokenStore.save(nextTokens) : Effect.void
        ).pipe(Effect.as([true, nextTokens] as const));
      });
    },
  );

  const runDpopRequest = <A>(
    input: {
      readonly accountToken: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
      readonly target: DpopProofTarget;
    },
    request: (
      authorization: ManagedRelayAuthorization,
    ) => Effect.Effect<A, ManagedRelayClientError>,
  ): Effect.Effect<A, ManagedRelayClientError> => {
    const attempt = (refreshRejectedToken: boolean): Effect.Effect<A, ManagedRelayClientError> =>
      authorize(input).pipe(
        Effect.flatMap((authorization) =>
          request(authorization).pipe(
            Effect.catchIf(isRejectedDpopAccessToken, (error) =>
              invalidateAccessToken(authorization.accessToken).pipe(
                Effect.tap((invalidated) =>
                  Effect.annotateCurrentSpan({
                    "relay.token_cache.invalidated": invalidated,
                    "relay.token_cache.invalidation_reason": "invalid_bearer",
                    "relay.token_cache.retry_after_invalidation": refreshRejectedToken,
                  }),
                ),
                Effect.tap((invalidated) =>
                  invalidated && refreshRejectedToken
                    ? Effect.logWarning(
                        "Relay rejected a cached DPoP access token; refreshing it once.",
                      )
                    : Effect.void,
                ),
                Effect.andThen(refreshRejectedToken ? attempt(false) : Effect.fail(error)),
              ),
            ),
          ),
        ),
      );
    return attempt(true);
  };

  const mobileRegistrationRequest = <A>(
    input: {
      readonly accountToken: string;
      readonly target: DpopProofTarget;
    },
    request: (
      authorization: ManagedRelayAuthorization,
    ) => Effect.Effect<A, ManagedRelayClientError>,
  ) =>
    runDpopRequest(
      {
        ...input,
        scopes: [RelayMobileRegistrationScope],
      },
      request,
    );

  /** Personal agent calls (#22) share one DPoP shape: the token's `environment:connect` scope. */
  const agentCall = <A>(
    accountToken: string,
    target: DpopProofTarget,
    call: (headers: ReturnType<typeof dpopHeaders>) => Effect.Effect<A, RelayHttpRequestError>,
  ) =>
    runDpopRequest(
      { accountToken, scopes: [RelayEnvironmentConnectScope], target },
      (authorization) =>
        call(dpopHeaders(authorization)).pipe(
          Effect.mapError(relayRequestError("call relay personal agent")),
          timeoutRelayRequest("Relay personal agent call"),
        ),
    );

  return ManagedRelayClient.of({
    relayUrl,
    listEnvironments: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .listEnvironments({ headers: bearerHeaders(input.accountToken) })
          .pipe(
            Effect.map((response) => response.environments),
            Effect.mapError(relayRequestError("list relay-managed environments")),
            timeoutRelayRequest("Relay environment listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.listEnvironments"),
      withRelayClientTracing,
    ),
    listDevices: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .listDevicesV2({
            headers: bearerHeaders(input.accountToken),
          })
          .pipe(
            Effect.map((response) => response.devices),
            Effect.mapError(relayRequestError("list relay client devices")),
            timeoutRelayRequest("Relay client device listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.listDevices"),
      withRelayClientTracing,
    ),
    createEnvironmentLinkChallenge: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .createEnvironmentLinkChallenge({
            headers: bearerHeaders(input.accountToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("create relay environment link challenge")),
            timeoutRelayRequest("Relay environment link challenge"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.createEnvironmentLinkChallenge"),
      withRelayClientTracing,
    ),
    linkEnvironment: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .linkEnvironment({
            headers: bearerHeaders(input.accountToken),
            payload: input.payload,
          })
          .pipe(
            Effect.mapError(relayRequestError("link relay environment")),
            timeoutRelayRequest("Relay environment linking"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.linkEnvironment"),
      withRelayClientTracing,
    ),
    unlinkEnvironment: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .unlinkEnvironment({
            headers: bearerHeaders(input.accountToken),
            params: { environmentId: input.environmentId },
          })
          .pipe(
            Effect.mapError(relayRequestError("unlink relay environment")),
            timeoutRelayRequest("Relay environment unlinking"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.unlinkEnvironment"),
      withRelayClientTracing,
    ),
    getEnvironmentStatus: Effect.fnUntraced(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "environment.id": input.environmentId,
        });
        return yield* runDpopRequest(
          {
            accountToken: input.accountToken,
            scopes: input.scopes,
            target: dpopProofTargets.getEnvironmentStatus(input.environmentId),
          },
          (authorization) =>
            client.dpopClient
              .getEnvironmentStatus({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
              })
              .pipe(
                Effect.mapError(relayRequestError("get relay environment status")),
                timeoutRelayRequest("Relay environment status request"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getEnvironmentStatus"),
      withRelayClientTracing,
    ),
    connectEnvironment: Effect.fnUntraced(
      function* (input) {
        yield* Effect.annotateCurrentSpan({
          "environment.id": input.environmentId,
        });
        return yield* runDpopRequest(
          {
            accountToken: input.accountToken,
            scopes: input.scopes,
            target: dpopProofTargets.connectEnvironment(input.environmentId),
          },
          (authorization) => {
            const payload: RelayEnvironmentConnectRequest = {
              ...(input.deviceId ? { deviceId: input.deviceId } : {}),
              clientKeyThumbprint: authorization.thumbprint,
            };
            return client.dpopClient
              .connectEnvironment({
                headers: dpopHeaders(authorization),
                params: { environmentId: input.environmentId },
                payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("connect relay environment")),
                timeoutRelayRequest("Relay environment connection"),
              );
          },
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.connectEnvironment"),
      withRelayClientTracing,
    ),
    registerDevice: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          {
            accountToken: input.accountToken,
            target: dpopProofTargets.registerDevice(),
          },
          (authorization) =>
            client.mobile
              .registerDevice({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("register relay mobile device")),
                timeoutRelayRequest("Relay mobile device registration"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.registerDevice"),
      withRelayClientTracing,
    ),
    unregisterDevice: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          {
            accountToken: input.accountToken,
            target: dpopProofTargets.unregisterDevice(input.deviceId),
          },
          (authorization) =>
            client.mobile
              .unregisterDevice({
                headers: dpopHeaders(authorization),
                params: { deviceId: input.deviceId },
              })
              .pipe(
                Effect.mapError(relayRequestError("unregister relay mobile device")),
                timeoutRelayRequest("Relay mobile device unregistration"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.unregisterDevice"),
      withRelayClientTracing,
    ),
    getAgentActivitySnapshot: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          {
            accountToken: input.accountToken,
            target: dpopProofTargets.getAgentActivitySnapshot(),
          },
          (authorization) =>
            client.mobile
              .getAgentActivitySnapshot({
                headers: dpopHeaders(authorization),
              })
              .pipe(
                Effect.mapError(relayRequestError("read relay agent activity snapshot")),
                timeoutRelayRequest("Relay agent activity snapshot"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getAgentActivitySnapshot"),
      withRelayClientTracing,
    ),
    registerLiveActivity: Effect.fnUntraced(
      function* (input) {
        return yield* mobileRegistrationRequest(
          {
            accountToken: input.accountToken,
            target: dpopProofTargets.registerLiveActivity(),
          },
          (authorization) =>
            client.mobile
              .registerLiveActivity({
                headers: dpopHeaders(authorization),
                payload: input.payload,
              })
              .pipe(
                Effect.mapError(relayRequestError("register relay live activity")),
                timeoutRelayRequest("Relay Live Activity registration"),
              ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.registerLiveActivity"),
      withRelayClientTracing,
    ),
    listSharedThreads: Effect.fnUntraced(
      function* (input) {
        return yield* runDpopRequest(
          {
            accountToken: input.accountToken,
            scopes: [RelayEnvironmentConnectScope],
            target: dpopProofTargets.listSharedThreads(),
          },
          (authorization) =>
            client.dpopClient.listSharedThreads({ headers: dpopHeaders(authorization) }).pipe(
              Effect.map((response) => response.threads),
              Effect.mapError(relayRequestError("list relay shared threads")),
              timeoutRelayRequest("Relay shared thread listing"),
            ),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.listSharedThreads"),
      withRelayClientTracing,
    ),
    authorizeSharedThreadEvents: Effect.fnUntraced(
      function* (input) {
        const target = dpopProofTargets.sharedThreadEvents();
        const authorization = yield* authorize({
          accountToken: input.accountToken,
          scopes: [RelayEnvironmentConnectScope],
          target,
        });
        const url = new URL(target.url);
        url.protocol = "wss:";
        url.searchParams.set(RelaySharedThreadEventsTokenParam, authorization.accessToken);
        url.searchParams.set(RelaySharedThreadEventsProofParam, authorization.proof);
        return url.href;
      },
      Effect.withSpan("clientRuntime.managedRelay.authorizeSharedThreadEvents"),
      withRelayClientTracing,
    ),
    authorizeVoice: Effect.fnUntraced(
      function* (input) {
        return yield* authorize({
          accountToken: input.accountToken,
          scopes: [RelayEnvironmentConnectScope],
          target: { method: input.method, url: input.url },
        });
      },
      Effect.withSpan("clientRuntime.managedRelay.authorizeVoice"),
      withRelayClientTracing,
    ),
    listOrgShareRequests: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .listOrgShareRequests({ headers: bearerHeaders(input.accountToken) })
          .pipe(
            Effect.map((response) => response.requests),
            Effect.mapError(relayRequestError("list relay organization share requests")),
            timeoutRelayRequest("Relay organization share request listing"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.listOrgShareRequests"),
      withRelayClientTracing,
    ),
    decideOrgShareRequest: Effect.fnUntraced(
      function* (input) {
        const request = {
          headers: bearerHeaders(input.accountToken),
          params: { id: input.requestId },
        };
        return yield* (
          input.decision === "approve"
            ? client.client.approveOrgShareRequest(request)
            : client.client.rejectOrgShareRequest(request)
        ).pipe(
          Effect.mapError(relayRequestError("decide relay organization share request")),
          timeoutRelayRequest("Relay organization share decision"),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.decideOrgShareRequest"),
      withRelayClientTracing,
    ),
    previewThreadInvite: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .previewThreadInvite({
            headers: bearerHeaders(input.accountToken),
            params: { token: input.token },
          })
          .pipe(
            Effect.catchTags({ RelayThreadInviteUnavailableError: () => Effect.succeed(null) }),
            Effect.mapError(relayRequestError("open relay thread invite")),
            timeoutRelayRequest("Relay thread invite"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.previewThreadInvite"),
      withRelayClientTracing,
    ),
    acceptThreadInvite: Effect.fnUntraced(
      function* (input) {
        return yield* client.client
          .acceptThreadInvite({
            headers: bearerHeaders(input.accountToken),
            params: { token: input.token },
          })
          .pipe(
            Effect.catchTags({ RelayThreadInviteUnavailableError: () => Effect.succeed(null) }),
            Effect.mapError(relayRequestError("open relay thread invite")),
            timeoutRelayRequest("Relay thread invite"),
          );
      },
      Effect.withSpan("clientRuntime.managedRelay.acceptThreadInvite"),
      withRelayClientTracing,
    ),
    getAgent: Effect.fnUntraced(
      function* (input) {
        return yield* agentCall(
          input.accountToken,
          {
            method: "GET",
            url: urlBuilder.dpopClient.getAgent(),
          },
          (headers) => client.dpopClient.getAgent({ headers }),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.getAgent"),
      withRelayClientTracing,
    ),
    disableAgent: Effect.fnUntraced(
      function* (input) {
        return yield* agentCall(
          input.accountToken,
          {
            method: "DELETE",
            url: urlBuilder.dpopClient.disableAgent(),
          },
          (headers) => client.dpopClient.disableAgent({ headers }),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.disableAgent"),
      withRelayClientTracing,
    ),
    setAgentBlocked: Effect.fnUntraced(
      function* (input) {
        const params = { accountId: input.accountId };
        return yield* input.blocked
          ? agentCall(
              input.accountToken,
              {
                method: "PUT",
                url: urlBuilder.dpopClient.blockAgentSender({ params }),
              },
              (headers) => client.dpopClient.blockAgentSender({ headers, params }),
            )
          : agentCall(
              input.accountToken,
              {
                method: "DELETE",
                url: urlBuilder.dpopClient.unblockAgentSender({ params }),
              },
              (headers) => client.dpopClient.unblockAgentSender({ headers, params }),
            );
      },
      Effect.withSpan("clientRuntime.managedRelay.setAgentBlocked"),
      withRelayClientTracing,
    ),
    agentAvailability: Effect.fnUntraced(
      function* (input) {
        const response = yield* agentCall(
          input.accountToken,
          {
            method: "POST",
            url: urlBuilder.dpopClient.agentAvailability(),
          },
          (headers) =>
            client.dpopClient.agentAvailability({
              headers,
              payload: { accountIds: [...input.accountIds] },
            }),
        );
        return response.available;
      },
      Effect.withSpan("clientRuntime.managedRelay.agentAvailability"),
      withRelayClientTracing,
    ),
    listAgentRequests: Effect.fnUntraced(
      function* (input) {
        return yield* agentCall(
          input.accountToken,
          {
            method: "GET",
            url: urlBuilder.dpopClient.listAgentRequests(),
          },
          (headers) => client.dpopClient.listAgentRequests({ headers }),
        );
      },
      Effect.withSpan("clientRuntime.managedRelay.listAgentRequests"),
      withRelayClientTracing,
    ),
    decideAgentRequest: Effect.fnUntraced(
      function* (input) {
        const params = { id: AgentRequestId.make(input.requestId) };
        const response = yield* agentCall(
          input.accountToken,
          {
            method: "POST",
            url: urlBuilder.dpopClient.decideAgentRequest({ params }),
          },
          (headers) =>
            client.dpopClient.decideAgentRequest({
              headers,
              params,
              payload: { decision: input.decision },
            }),
        );
        return response.request;
      },
      Effect.withSpan("clientRuntime.managedRelay.decideAgentRequest"),
      withRelayClientTracing,
    ),
    cancelAgentRequest: Effect.fnUntraced(
      function* (input) {
        const params = { id: AgentRequestId.make(input.requestId) };
        const response = yield* agentCall(
          input.accountToken,
          {
            method: "POST",
            url: urlBuilder.dpopClient.cancelAgentRequest({ params }),
          },
          (headers) => client.dpopClient.cancelAgentRequest({ headers, params }),
        );
        return response.request;
      },
      Effect.withSpan("clientRuntime.managedRelay.cancelAgentRequest"),
      withRelayClientTracing,
    ),
    resetTokenCache: SynchronizedRef.set(cachedTokens, []).pipe(
      Effect.andThen(options.accessTokenStore ? options.accessTokenStore.clear : Effect.void),
      Effect.withSpan("clientRuntime.managedRelay.resetTokenCache"),
      withRelayClientTracing,
    ),
  });
});

export const layer = (options: ManagedRelayClientLayerOptions) =>
  Layer.effect(ManagedRelayClient, make(options));
