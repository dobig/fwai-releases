import type { DesktopFwaiGatewayRequest, DesktopFwaiGatewayResponse } from "@t3tools/contracts";
import { FWAI_DEFAULT_GATEWAY_URL, normalizeFwaiGatewayUrl } from "@t3tools/shared/fwaiGateway";
import { fromLenientJson } from "@t3tools/shared/schemaJson";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Base64 from "effect/encoding/Base64";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpMethod } from "effect/http";

import * as ElectronSafeStorage from "../electron/ElectronSafeStorage.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";

declare const __T3CODE_BUILD_FWAI_GATEWAY_URL__: string | undefined;

// The renderer is built with the same value, so a runtime override would only make them disagree.
export const fwaiGatewayOrigin =
  normalizeFwaiGatewayUrl(
    typeof __T3CODE_BUILD_FWAI_GATEWAY_URL__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_FWAI_GATEWAY_URL__,
  ) ?? FWAI_DEFAULT_GATEWAY_URL;

const FWAI_ACCOUNT_PATHS = new Set([
  "/v1/auth/login",
  "/v1/auth/login/verify",
  "/oauth/token",
  "/v1/account/logout",
  "/v1/auth/introspect",
  // Approves this account's own environment for fwai Gateway routing without a second sign-in.
  "/v1/oauth/device/approve",
  // Registers a connected environment's attestation key under this account (llm_gateway#760).
  "/v1/me/fwai/environments",
  // Plan and quota shown beside the fwai Gateway switch.
  "/api/oauth/usage",
  "/v1/subscription",
]);
// The organization directory the share dialog reads (#20): read-only, and members takes a query.
const FWAI_DIRECTORY_PATHS = new Map([
  ["/v1/me/organization", { query: false }],
  ["/v1/me/organization/members", { query: true }],
]);
const FORWARDED_REQUEST_HEADERS = new Set(["accept", "authorization"]);
const GATEWAY_FETCH_TIMEOUT = Duration.seconds(20);

export class DesktopFwaiGatewayFetchError extends Schema.TaggedError<DesktopFwaiGatewayFetchError>()(
  "DesktopFwaiGatewayFetchError",
  { reason: Schema.Literals(["not-allowed", "unreachable"]) },
) {
  override get message(): string {
    return this.reason === "not-allowed"
      ? "The fwai gateway request is not allowed."
      : "The fwai gateway could not be reached.";
  }
}

/** The request URL when it targets an fwai account endpoint on the configured gateway. */
export function allowedFwaiGatewayUrl(
  request: Pick<DesktopFwaiGatewayRequest, "url" | "method">,
  gatewayOrigin: string,
): Option.Option<URL> {
  let url: URL;
  try {
    url = new URL(request.url);
  } catch {
    return Option.none();
  }
  const directory = FWAI_DIRECTORY_PATHS.get(url.pathname);
  const allowed =
    url.origin === gatewayOrigin &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    (directory === undefined
      ? url.search === "" &&
        FWAI_ACCOUNT_PATHS.has(url.pathname) &&
        (request.method === "GET" || request.method === "POST")
      : request.method === "GET" && (directory.query || url.search === ""));
  return allowed ? Option.some(url) : Option.none();
}

export const fetchFwaiGateway = Effect.fn("desktop.fwaiGateway.fetch")(function* (
  request: DesktopFwaiGatewayRequest,
  gatewayOrigin: string,
): Effect.fn.Return<
  DesktopFwaiGatewayResponse,
  DesktopFwaiGatewayFetchError,
  HttpClient.HttpClient
> {
  const method = request.method.toUpperCase();
  const url = allowedFwaiGatewayUrl({ url: request.url, method }, gatewayOrigin);
  if (Option.isNone(url) || !HttpMethod.isHttpMethod(method)) {
    return yield* new DesktopFwaiGatewayFetchError({ reason: "not-allowed" });
  }
  const headers: Record<string, string> = {};
  let contentType: string | undefined;
  for (const [name, value] of Object.entries(request.headers)) {
    const key = name.toLowerCase();
    if (key === "content-type") contentType = value;
    else if (FORWARDED_REQUEST_HEADERS.has(key)) headers[key] = value;
  }
  let httpRequest = HttpClientRequest.make(method)(url.value).pipe(
    HttpClientRequest.setHeaders(headers),
  );
  if (request.body !== null) {
    httpRequest = HttpClientRequest.bodyText(httpRequest, request.body, contentType);
  }
  const client = yield* HttpClient.HttpClient;
  // Errors carry the request (and its Authorization header), so they are dropped, never logged.
  return yield* client.execute(httpRequest).pipe(
    Effect.flatMap((response) =>
      response.text.pipe(
        Effect.map((body) => {
          const { "set-cookie": _cookie, ...responseHeaders } = response.headers;
          return { status: response.status, headers: responseHeaders, body };
        }),
      ),
    ),
    Effect.timeout(GATEWAY_FETCH_TIMEOUT),
    Effect.mapError(() => new DesktopFwaiGatewayFetchError({ reason: "unreachable" })),
  );
});

const EncryptedSessionDocument = Schema.Struct({
  version: Schema.Literal(1),
  encryptedSession: Schema.String,
});
const EncryptedSessionDocumentJson = fromLenientJson(EncryptedSessionDocument);
const decodeEncryptedSessionDocument = Schema.decodeEffect(EncryptedSessionDocumentJson);
const encodeEncryptedSessionDocument = Schema.encodeEffect(EncryptedSessionDocumentJson);

export class DesktopFwaiAccountStoreWriteError extends Schema.TaggedError<DesktopFwaiAccountStoreWriteError>()(
  "DesktopFwaiAccountStoreWriteError",
  {
    operation: Schema.Literals(["check-encryption", "encrypt", "encode", "write"]),
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Saving the fwai account session failed during ${this.operation} at ${this.path}.`;
  }
}

export class DesktopFwaiAccountStore extends Context.Service<
  DesktopFwaiAccountStore,
  {
    /** None when nothing is stored or it cannot be decrypted on this machine. */
    readonly get: Effect.Effect<Option.Option<string>>;
    /** Persists only when safeStorage can encrypt; otherwise the session lasts for this run. */
    readonly set: (session: string) => Effect.Effect<void, DesktopFwaiAccountStoreWriteError>;
    readonly clear: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopFwaiAccount/DesktopFwaiAccountStore") {}

/** @public */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const safeStorage = yield* ElectronSafeStorage.ElectronSafeStorage;
  const sessionPath = path.join(environment.stateDir, "fwai-account-session.json");
  const writeError =
    (operation: DesktopFwaiAccountStoreWriteError["operation"]) => (cause: unknown) =>
      new DesktopFwaiAccountStoreWriteError({ operation, path: sessionPath, cause });

  const get = Effect.gen(function* () {
    const raw = yield* fileSystem.readFileString(sessionPath);
    const document = yield* decodeEncryptedSessionDocument(raw);
    if (!(yield* safeStorage.isEncryptionAvailable)) return Option.none<string>();
    const encrypted = yield* Effect.fromResult(Base64.decode(document.encryptedSession));
    return Option.some(yield* safeStorage.decryptString(encrypted));
  }).pipe(
    Effect.catch((error) =>
      error._tag === "PlatformError" && error.reason._tag === "NotFound"
        ? Effect.succeedNone
        : Effect.logWarning("Could not read the saved fwai account session.", {
            sessionPath,
            error: error._tag,
          }).pipe(Effect.as(Option.none<string>())),
    ),
    Effect.withSpan("desktop.fwaiAccountStore.get"),
  );

  const set = Effect.fn("desktop.fwaiAccountStore.set")(function* (session: string) {
    if (
      !(yield* safeStorage.isEncryptionAvailable.pipe(
        Effect.mapError(writeError("check-encryption")),
      ))
    ) {
      yield* Effect.logWarning(
        "Secure storage is unavailable; the fwai account session is kept for this run only.",
      );
      return;
    }
    const encryptedSession = Base64.encode(
      yield* safeStorage.encryptString(session).pipe(Effect.mapError(writeError("encrypt"))),
    );
    const encoded = yield* encodeEncryptedSessionDocument({ version: 1, encryptedSession }).pipe(
      Effect.mapError(writeError("encode")),
    );
    const suffix = (yield* crypto
      .randomUUIDv4()
      .pipe(Effect.mapError(writeError("write")))).replace(/-/g, "");
    const tempPath = `${sessionPath}.${suffix}.tmp`;
    yield* Effect.gen(function* () {
      yield* fileSystem.makeDirectory(path.dirname(sessionPath), { recursive: true });
      yield* fileSystem.writeFileString(tempPath, `${encoded}\n`, { mode: 0o600 });
      yield* fileSystem.rename(tempPath, sessionPath);
    }).pipe(
      Effect.mapError(writeError("write")),
      Effect.ensuring(fileSystem.remove(tempPath, { force: true }).pipe(Effect.ignore)),
    );
  });

  const clear = fileSystem.remove(sessionPath, { force: true }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not clear the saved fwai account session.", { sessionPath, error }),
    ),
    Effect.withSpan("desktop.fwaiAccountStore.clear"),
  );

  return DesktopFwaiAccountStore.of({ get, set, clear });
});

export const layer = Layer.effect(DesktopFwaiAccountStore, make);
