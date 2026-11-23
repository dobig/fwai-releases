/**
 * The llm_gateway account protocol (sign-in, refresh, sign-out, introspection,
 * device code) shared by every fwai surface. Contract: dobig/llm_gateway#520.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/http";

export const FWAI_DEFAULT_GATEWAY_URL = "https://api.fwai.space";
export const FWAI_DEFAULT_CLIENT_ID = "fwai";
export const FWAI_DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

const GATEWAY_REQUEST_TIMEOUT = Duration.seconds(15);

export interface FwaiGatewayConfig {
  /** Origin of the gateway, e.g. `https://api.fwai.space`. */
  readonly gatewayUrl: string;
  readonly clientId: string;
}

/** What the gateway records for the installation a session belongs to. */
export interface FwaiDeviceInfo {
  readonly deviceName: string;
  readonly platform: string;
  readonly appVersion: string;
}

/**
 * Accepts a configured gateway URL and returns its origin, or null when it is
 * not an absolute https URL (http is allowed for loopback, for local gateways).
 */
export function normalizeFwaiGatewayUrl(value: string | undefined | null): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw);
    const loopback =
      url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
    return url.origin;
  } catch {
    return null;
  }
}

export const FwaiGatewayUser = Schema.Struct({
  id: Schema.String,
  username: Schema.String,
  email: Schema.optional(Schema.String),
});
export type FwaiGatewayUser = typeof FwaiGatewayUser.Type;

/** `/oauth/token` response; also the token part of a login response. */
export const FwaiGatewayTokenResponse = Schema.Struct({
  token_type: Schema.String,
  access_token: Schema.String,
  refresh_token: Schema.String,
  /** 0 means the access token does not expire (it is revoked through its refresh token). */
  expires_in: Schema.Number,
  installation_id: Schema.optional(Schema.String),
});
export type FwaiGatewayTokenResponse = typeof FwaiGatewayTokenResponse.Type;

export const FwaiGatewayLoginResponse = Schema.Struct({
  ...FwaiGatewayTokenResponse.fields,
  user: FwaiGatewayUser,
});
export type FwaiGatewayLoginResponse = typeof FwaiGatewayLoginResponse.Type;

/** `409` from `/v1/auth/login`: the password was right, now a mailed code is needed. */
export const FwaiGatewayLoginChallenge = Schema.Struct({
  error: Schema.Literal("email_code_required"),
  challenge_id: Schema.String,
  email_hint: Schema.String,
  expires_in: Schema.Number,
  /** False when the resend cooldown suppressed a new mail; the previous code still works. */
  sent: Schema.Boolean,
});
export type FwaiGatewayLoginChallenge = typeof FwaiGatewayLoginChallenge.Type;

export const FwaiGatewayIntrospection = Schema.Struct({
  active: Schema.Boolean,
  sub: Schema.optional(Schema.String),
  // Same value as the members directory's; absent from gateways that predate it.
  username: Schema.optional(Schema.String),
  account_id: Schema.optional(Schema.String),
  client_id: Schema.optional(Schema.String),
  scopes: Schema.optional(Schema.Array(Schema.String)),
  user_status: Schema.optional(Schema.String),
  fwai_access: Schema.Struct({
    allowed: Schema.Boolean,
    via: Schema.optional(Schema.NullOr(Schema.String)),
  }),
  // llm_gateway#629; absent from gateways that predate it, null outside an organization.
  organization: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        id: Schema.String,
        role: Schema.Literals(["owner", "member"]),
        project_ids: Schema.Array(Schema.String),
        // llm_gateway#661; absent from gateways that predate it, which means "not allowed".
        allow_external_sharing: Schema.optional(Schema.Boolean),
      }),
    ),
  ),
});
export type FwaiGatewayIntrospection = typeof FwaiGatewayIntrospection.Type;

/**
 * `GET /v1/me/organization`. With a fwai token an org owner gets every project, and `member`
 * marks their own; everyone else gets only their projects (llm_gateway#629).
 */
const FwaiGatewayProjectWindow = Schema.Struct({ used_percent: Schema.Number });

export const FwaiGatewayOrganizationResponse = Schema.Struct({
  organization: Schema.NullOr(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      role: Schema.Literals(["owner", "member"]),
    }),
  ),
  projects: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      // Gateways that predate llm_gateway#629 list only the caller's own projects.
      member: Schema.optional(Schema.Boolean),
      // Quota fields, absent on gateways that predate them: whether the caller has an allowance
      // here, and how much of each window is used (0-100).
      has_allowance: Schema.optional(Schema.Boolean),
      five_hour: Schema.optional(Schema.NullOr(FwaiGatewayProjectWindow)),
      week: Schema.optional(Schema.NullOr(FwaiGatewayProjectWindow)),
    }),
  ),
  /** The project the caller's requests draw on when they name none; null outside any. */
  current_project_id: Schema.optional(Schema.NullOr(Schema.String)),
});
export type FwaiGatewayOrganizationResponse = typeof FwaiGatewayOrganizationResponse.Type;

/** One colleague from `GET /v1/me/organization/members`. Never carries an email. */
export const FwaiGatewayOrganizationMember = Schema.Struct({
  user_id: Schema.String,
  username: Schema.String,
  role: Schema.Literals(["owner", "member"]),
  project_ids: Schema.Array(Schema.String),
});
export type FwaiGatewayOrganizationMember = typeof FwaiGatewayOrganizationMember.Type;

export const FwaiGatewayOrganizationMembersResponse = Schema.Struct({
  members: Schema.Array(FwaiGatewayOrganizationMember),
  next_cursor: Schema.NullOr(Schema.String),
});
export type FwaiGatewayOrganizationMembersResponse =
  typeof FwaiGatewayOrganizationMembersResponse.Type;

/** The gateway accepts at most this many ids per members lookup. */
export const FWAI_MEMBER_IDS_LIMIT = 100;

export const FwaiGatewayDeviceCode = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.String,
  verification_uri: Schema.String,
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.Number,
  interval: Schema.optional(Schema.Number),
});
export type FwaiGatewayDeviceCode = typeof FwaiGatewayDeviceCode.Type;

const FwaiGatewayErrorBody = Schema.Struct({
  error: Schema.String,
  retry_after: Schema.optional(Schema.Number),
});
const decodeErrorBody = Schema.decodeUnknownOption(FwaiGatewayErrorBody);

export const FwaiGatewayOperation = Schema.Literals([
  "login",
  "verifyLogin",
  "refresh",
  "logout",
  "introspect",
  "deviceCode",
  "deviceToken",
  "deviceApprove",
  "usage",
  "subscription",
  "organization",
  "organizationMembers",
]);
export type FwaiGatewayOperation = typeof FwaiGatewayOperation.Type;

export class FwaiGatewayError extends Schema.TaggedError<FwaiGatewayError>()("FwaiGatewayError", {
  operation: FwaiGatewayOperation,
  /** HTTP status; absent when the gateway could not be reached. */
  status: Schema.optional(Schema.Number),
  /** The gateway's `error` code, e.g. `invalid_credentials`. */
  code: Schema.optional(Schema.String),
  retryAfterSeconds: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    if (this.status === undefined) return `Could not reach the fwai gateway (${this.operation}).`;
    return `fwai gateway ${this.operation} failed with ${this.status}${
      this.code ? ` (${this.code})` : ""
    }.`;
  }
}

/**
 * True when a refresh was refused for good (revoked, unknown or malformed
 * refresh token) rather than failing in transit. The session cannot recover
 * and the user has to sign in again.
 */
export function isPermanentFwaiRefreshFailure(error: FwaiGatewayError): boolean {
  return (
    error.status !== undefined &&
    error.status >= 400 &&
    error.status < 500 &&
    error.status !== 408 &&
    error.status !== 429
  );
}

function gatewayUrl(config: FwaiGatewayConfig, path: string): string {
  return new URL(path, config.gatewayUrl).toString();
}

const execute = Effect.fn("fwaiGateway.execute")(function* (
  operation: FwaiGatewayOperation,
  request: HttpClientRequest.HttpClientRequest,
) {
  const client = yield* HttpClient.HttpClient;
  return yield* client.execute(HttpClientRequest.acceptJson(request)).pipe(
    // b3/traceparent are not in the gateway's CORS allow-list; browsers would fail the preflight.
    Effect.provideService(HttpClient.TracerPropagationEnabled, false),
    Effect.timeout(GATEWAY_REQUEST_TIMEOUT),
    Effect.mapError((cause) => new FwaiGatewayError({ operation, cause })),
  );
});

const failWithResponse = Effect.fn("fwaiGateway.failWithResponse")(function* (
  operation: FwaiGatewayOperation,
  response: HttpClientResponse.HttpClientResponse,
) {
  const body = yield* response.json.pipe(Effect.option);
  const decoded = Option.flatMap(body, decodeErrorBody);
  return yield* new FwaiGatewayError({
    operation,
    status: response.status,
    ...(Option.isSome(decoded)
      ? {
          code: decoded.value.error,
          ...(decoded.value.retry_after === undefined
            ? {}
            : { retryAfterSeconds: decoded.value.retry_after }),
        }
      : {}),
  });
});

const decodeBody = <S extends Schema.Top>(
  operation: FwaiGatewayOperation,
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
) =>
  response.json.pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError((cause) => new FwaiGatewayError({ operation, status: response.status, cause })),
  ) as Effect.Effect<S["Type"], FwaiGatewayError, S["DecodingServices"]>;

const isOk = (response: HttpClientResponse.HttpClientResponse) =>
  response.status >= 200 && response.status < 300;

export type FwaiLoginResult =
  | { readonly _tag: "Session"; readonly session: FwaiGatewayLoginResponse }
  | { readonly _tag: "EmailCodeRequired"; readonly challenge: FwaiGatewayLoginChallenge };

/** `POST /v1/auth/login`. `username` may also be the account's email address. */
export const login = Effect.fn("fwaiGateway.login")(function* (
  config: FwaiGatewayConfig,
  input: { readonly username: string; readonly password: string; readonly device: FwaiDeviceInfo },
) {
  const response = yield* execute(
    "login",
    HttpClientRequest.post(gatewayUrl(config, "/v1/auth/login")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        username: input.username,
        password: input.password,
        device_name: input.device.deviceName,
        platform: input.device.platform,
        app_version: input.device.appVersion,
        client_id: config.clientId,
      }),
    ),
  );
  if (isOk(response)) {
    const session = yield* decodeBody("login", response, FwaiGatewayLoginResponse);
    return { _tag: "Session", session } satisfies FwaiLoginResult as FwaiLoginResult;
  }
  if (response.status === 409) {
    const challenge = yield* decodeBody("login", response, FwaiGatewayLoginChallenge);
    return { _tag: "EmailCodeRequired", challenge } satisfies FwaiLoginResult as FwaiLoginResult;
  }
  return yield* failWithResponse("login", response);
});

/** `POST /v1/auth/login/verify`: second step of a two-step login. */
export const verifyLogin = Effect.fn("fwaiGateway.verifyLogin")(function* (
  config: FwaiGatewayConfig,
  input: { readonly challengeId: string; readonly code: string },
) {
  const response = yield* execute(
    "verifyLogin",
    HttpClientRequest.post(gatewayUrl(config, "/v1/auth/login/verify")).pipe(
      HttpClientRequest.bodyJsonUnsafe({ challenge_id: input.challengeId, code: input.code }),
    ),
  );
  if (isOk(response)) return yield* decodeBody("verifyLogin", response, FwaiGatewayLoginResponse);
  return yield* failWithResponse("verifyLogin", response);
});

/** `POST /oauth/token` refresh grant. The refresh token rotates: store the new one. */
export const refresh = Effect.fn("fwaiGateway.refresh")(function* (
  config: FwaiGatewayConfig,
  refreshToken: string,
) {
  const response = yield* execute(
    "refresh",
    HttpClientRequest.post(gatewayUrl(config, "/oauth/token")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    ),
  );
  if (isOk(response)) return yield* decodeBody("refresh", response, FwaiGatewayTokenResponse);
  return yield* failWithResponse("refresh", response);
});

/** `POST /v1/account/logout`: revokes this installation's session on the gateway. */
export const logout = Effect.fn("fwaiGateway.logout")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
) {
  const response = yield* execute(
    "logout",
    HttpClientRequest.post(gatewayUrl(config, "/v1/account/logout")).pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (isOk(response)) {
    yield* Effect.ignore(response.text);
    return;
  }
  return yield* failWithResponse("logout", response);
});

/** `GET /v1/auth/introspect` (llm_gateway#514). */
export const introspect = Effect.fn("fwaiGateway.introspect")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
) {
  const response = yield* execute(
    "introspect",
    HttpClientRequest.get(gatewayUrl(config, "/v1/auth/introspect")).pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (isOk(response)) return yield* decodeBody("introspect", response, FwaiGatewayIntrospection);
  return yield* failWithResponse("introspect", response);
});

/**
 * `POST /v1/oauth/device/approve`: a signed-in client approves a device code for its own account,
 * so an environment it controls gets a session without a second sign-in.
 */
export const approveDeviceCode = Effect.fn("fwaiGateway.approveDeviceCode")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
  userCode: string,
) {
  const response = yield* execute(
    "deviceApprove",
    HttpClientRequest.post(gatewayUrl(config, "/v1/oauth/device/approve")).pipe(
      HttpClientRequest.bearerToken(accessToken),
      HttpClientRequest.bodyJsonUnsafe({ user_code: userCode, approve: true }),
    ),
  );
  if (isOk(response)) {
    yield* Effect.ignore(response.text);
    return;
  }
  return yield* failWithResponse("deviceApprove", response);
});

const FwaiGatewayUsageWindow = Schema.NullOr(
  Schema.Struct({ utilization: Schema.Number, resets_at: Schema.optional(Schema.String) }),
);
/** `GET /api/oauth/usage`: the account's quota use, 0-100 per window; null without a plan. */
export const FwaiGatewayUsage = Schema.Struct({
  five_hour: Schema.optional(FwaiGatewayUsageWindow),
  seven_day: Schema.optional(FwaiGatewayUsageWindow),
});
export type FwaiGatewayUsage = typeof FwaiGatewayUsage.Type;

/** `GET /v1/subscription`; only the fields fwai shows. */
export const FwaiGatewaySubscription = Schema.Struct({
  subscription: Schema.Struct({
    active: Schema.Boolean,
    tier: Schema.optional(Schema.String),
    label: Schema.optional(Schema.String),
    valid_until: Schema.optional(Schema.String),
  }),
});
export type FwaiGatewaySubscription = typeof FwaiGatewaySubscription.Type;

export const getUsage = Effect.fn("fwaiGateway.getUsage")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
) {
  const response = yield* execute(
    "usage",
    HttpClientRequest.get(gatewayUrl(config, "/api/oauth/usage")).pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (isOk(response)) return yield* decodeBody("usage", response, FwaiGatewayUsage);
  return yield* failWithResponse("usage", response);
});

export const getSubscription = Effect.fn("fwaiGateway.getSubscription")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
) {
  const response = yield* execute(
    "subscription",
    HttpClientRequest.get(gatewayUrl(config, "/v1/subscription")).pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (isOk(response)) return yield* decodeBody("subscription", response, FwaiGatewaySubscription);
  return yield* failWithResponse("subscription", response);
});

/** `GET /v1/me/organization`, with the user's fwai access token. */
export const getOrganization = Effect.fn("fwaiGateway.getOrganization")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
) {
  const response = yield* execute(
    "organization",
    HttpClientRequest.get(gatewayUrl(config, "/v1/me/organization")).pipe(
      HttpClientRequest.bearerToken(accessToken),
    ),
  );
  if (isOk(response)) {
    return yield* decodeBody("organization", response, FwaiGatewayOrganizationResponse);
  }
  return yield* failWithResponse("organization", response);
});

export interface FwaiOrganizationMembersQuery {
  /** Case-insensitive username prefix. */
  readonly q?: string;
  readonly projectId?: string;
  /** Resolves these user ids to usernames; ids outside the organization are left out. */
  readonly ids?: ReadonlyArray<string>;
  readonly limit?: number;
  readonly cursor?: string;
}

/**
 * `GET /v1/me/organization/members`. Fails with `404 not_org_member` outside an organization,
 * `404 project_not_found`, and `400 invalid_ids | invalid_limit | invalid_cursor`.
 */
export const listOrganizationMembers = Effect.fn("fwaiGateway.listOrganizationMembers")(function* (
  config: FwaiGatewayConfig,
  accessToken: string,
  query: FwaiOrganizationMembersQuery,
) {
  const url = new URL("/v1/me/organization/members", config.gatewayUrl);
  if (query.q) url.searchParams.set("q", query.q);
  if (query.projectId) url.searchParams.set("project_id", query.projectId);
  if (query.ids !== undefined) url.searchParams.set("ids", query.ids.join(","));
  if (query.limit !== undefined) url.searchParams.set("limit", String(query.limit));
  if (query.cursor) url.searchParams.set("cursor", query.cursor);
  const response = yield* execute(
    "organizationMembers",
    HttpClientRequest.get(url.toString()).pipe(HttpClientRequest.bearerToken(accessToken)),
  );
  if (isOk(response)) {
    return yield* decodeBody(
      "organizationMembers",
      response,
      FwaiGatewayOrganizationMembersResponse,
    );
  }
  return yield* failWithResponse("organizationMembers", response);
});

/** True when the presented token belongs to an active user with fwai access. */
export function introspectionAllowsFwai(result: FwaiGatewayIntrospection): boolean {
  return result.active && result.fwai_access.allowed && Boolean(result.sub);
}

/** `POST /oauth/device/code` (RFC 8628, llm_gateway#515). */
export const requestDeviceCode = Effect.fn("fwaiGateway.requestDeviceCode")(function* (
  config: FwaiGatewayConfig,
  device: FwaiDeviceInfo,
) {
  const response = yield* execute(
    "deviceCode",
    HttpClientRequest.post(gatewayUrl(config, "/oauth/device/code")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        client_id: config.clientId,
        device_name: device.deviceName,
        platform: device.platform,
        app_version: device.appVersion,
      }),
    ),
  );
  if (isOk(response)) return yield* decodeBody("deviceCode", response, FwaiGatewayDeviceCode);
  return yield* failWithResponse("deviceCode", response);
});

export type FwaiDeviceTokenPoll =
  | { readonly _tag: "Token"; readonly token: FwaiGatewayTokenResponse }
  | { readonly _tag: "Pending" }
  | { readonly _tag: "SlowDown" };

/**
 * One poll of `/oauth/token` with the device-code grant. Pending and slow_down
 * are results; `access_denied`, `expired_token` and anything else fail with the
 * gateway's code. The caller owns the interval.
 */
export const pollDeviceToken = Effect.fn("fwaiGateway.pollDeviceToken")(function* (
  config: FwaiGatewayConfig,
  deviceCode: string,
) {
  const response = yield* execute(
    "deviceToken",
    HttpClientRequest.post(gatewayUrl(config, "/oauth/token")).pipe(
      HttpClientRequest.bodyJsonUnsafe({
        grant_type: FWAI_DEVICE_CODE_GRANT_TYPE,
        device_code: deviceCode,
        client_id: config.clientId,
      }),
    ),
  );
  if (isOk(response)) {
    const token = yield* decodeBody("deviceToken", response, FwaiGatewayTokenResponse);
    return { _tag: "Token", token } satisfies FwaiDeviceTokenPoll as FwaiDeviceTokenPoll;
  }
  const failure = yield* failWithResponse("deviceToken", response).pipe(Effect.flip);
  switch (failure.code) {
    case "authorization_pending":
      return { _tag: "Pending" } satisfies FwaiDeviceTokenPoll as FwaiDeviceTokenPoll;
    case "slow_down":
      return { _tag: "SlowDown" } satisfies FwaiDeviceTokenPoll as FwaiDeviceTokenPoll;
    default:
      return yield* failure;
  }
});

/** A short, user-facing explanation of a failed sign-in step. */
export function describeFwaiSignInError(error: FwaiGatewayError): string {
  if (error.status === undefined) return "Could not reach the fwai account server. Try again.";
  switch (error.code) {
    case "invalid_credentials":
      return "Incorrect username or password.";
    case "missing_required_fields":
      return "Enter your username and password.";
    case "account_disabled":
      return "This account is disabled.";
    case "too_many_attempts":
      return error.operation === "verifyLogin"
        ? "Too many incorrect codes. Sign in again."
        : error.retryAfterSeconds === undefined
          ? "Too many attempts. Try again later."
          : `Too many attempts. Try again in ${error.retryAfterSeconds} seconds.`;
    case "invalid_code":
      return "Incorrect code.";
    case "code_expired":
    case "challenge_expired":
      return "The code expired. Sign in again.";
    case "invalid_challenge":
      return "This sign-in expired. Sign in again.";
    case "unknown_client":
      return "The fwai account server does not accept this app yet.";
    default:
      return error.status >= 500
        ? "The fwai account server had a problem. Try again."
        : "Sign-in failed. Try again.";
  }
}
