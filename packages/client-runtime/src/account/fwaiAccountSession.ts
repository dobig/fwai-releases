import * as FwaiGateway from "@t3tools/shared/fwaiGateway";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { HttpClient } from "effect/http";

import type { CloudAccountSource } from "../relay/cloudAccountService.ts";

/** Refresh this long before the gateway's stated expiry. */
const REFRESH_EARLY_MS = 60_000;
/** Foreground access checks closer together than this reuse the last answer. */
const ACCESS_CHECK_MIN_INTERVAL_MS = 30_000;

export interface FwaiAccountUser {
  readonly id: string;
  readonly username: string;
  readonly email: string | null;
}

/**
 * `unverified`: the gateway could not answer (unreachable, or introspection not
 * deployed yet). Treated as allowed so an outage does not lock users out; the
 * relay still checks every remote connection.
 */
export type FwaiAccess = "checking" | "allowed" | "denied" | "unverified";

export type FwaiAccountState =
  | { readonly status: "loading" }
  | { readonly status: "signedOut"; readonly error: string | null }
  | {
      readonly status: "codeRequired";
      readonly emailHint: string;
      readonly codeSent: boolean;
      readonly error: string | null;
    }
  | { readonly status: "signedIn"; readonly user: FwaiAccountUser; readonly access: FwaiAccess };

/** Where the session is kept: the keychain on desktop and mobile, browser storage on web. */
export interface FwaiAccountStorage {
  readonly load: () => Promise<string | null>;
  readonly save: (value: string) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export interface FwaiAccountSessionOptions {
  readonly gateway: FwaiGateway.FwaiGatewayConfig;
  readonly device: FwaiGateway.FwaiDeviceInfo;
  readonly storage: FwaiAccountStorage;
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
  readonly now?: () => number;
  /** Failures that do not change what the user sees (storage, logout) are reported here. */
  readonly onBackgroundError?: (label: string, error: unknown) => void;
}

const PersistedSession = Schema.Struct({
  accessToken: Schema.String,
  refreshToken: Schema.String,
  /** Null when the gateway issued a non-expiring access token. */
  expiresAtEpochMs: Schema.NullOr(Schema.Number),
  user: Schema.Struct({
    id: Schema.String,
    username: Schema.String,
    email: Schema.NullOr(Schema.String),
  }),
});
type PersistedSession = typeof PersistedSession.Type;
const PersistedSessionJson = Schema.fromJsonString(PersistedSession);
const decodePersistedSession = Schema.decodeUnknownOption(PersistedSessionJson);
const encodePersistedSession = Schema.encodeSync(PersistedSessionJson);

export interface FwaiAccountSession extends CloudAccountSource {
  readonly getState: () => FwaiAccountState;
  readonly subscribe: (listener: () => void) => () => void;
  /** Loads the stored session. Safe to call more than once. */
  readonly start: () => Promise<void>;
  readonly signIn: (input: {
    readonly username: string;
    readonly password: string;
  }) => Promise<void>;
  readonly verifyCode: (code: string) => Promise<void>;
  /** Leaves the code step and returns to the password form. */
  readonly cancelCode: () => void;
  readonly signOut: () => Promise<void>;
  /** A current access token, refreshing first when it is about to expire. Null when signed out. */
  readonly getAccessToken: () => Promise<string | null>;
  /** Asks the gateway whether this account may use fwai. Throttled unless `force`. */
  readonly checkAccess: (options?: { readonly force?: boolean }) => Promise<void>;
}

export function createFwaiAccountSession(options: FwaiAccountSessionOptions): FwaiAccountSession {
  // @effect-diagnostics-next-line globalDate:off
  const now = options.now ?? (() => Date.now());
  const reportBackground = options.onBackgroundError ?? (() => undefined);
  const run = <A>(effect: Effect.Effect<A, FwaiGateway.FwaiGatewayError, HttpClient.HttpClient>) =>
    Effect.runPromiseExit(Effect.provide(effect, options.httpClient));

  let state: FwaiAccountState = { status: "loading" };
  let session: PersistedSession | null = null;
  let challengeId: string | null = null;
  // Bumped whenever the signed-in session is replaced, so late results for an
  // older session (a refresh, an access check) are dropped.
  let generation = 0;
  let starting: Promise<void> | null = null;
  let refreshing: Promise<PersistedSession | null> | null = null;
  let checking: Promise<void> | null = null;
  let lastAccessCheckAt: number | null = null;
  const listeners = new Set<() => void>();

  const setState = (next: FwaiAccountState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const persist = async (next: PersistedSession) => {
    try {
      await options.storage.save(encodePersistedSession(next));
    } catch (error) {
      reportBackground("save fwai session", error);
    }
  };

  const signedInState = (access: FwaiAccess): FwaiAccountState =>
    session
      ? { status: "signedIn", user: session.user, access }
      : { status: "signedOut", error: null };

  const clearLocal = async (error: string | null = null) => {
    generation += 1;
    session = null;
    challengeId = null;
    lastAccessCheckAt = null;
    setState({ status: "signedOut", error });
    try {
      await options.storage.clear();
    } catch (cause) {
      reportBackground("clear fwai session", cause);
    }
  };

  const expiresAt = (expiresIn: number) => (expiresIn > 0 ? now() + expiresIn * 1_000 : null);

  const adopt = async (response: FwaiGateway.FwaiGatewayLoginResponse) => {
    generation += 1;
    challengeId = null;
    lastAccessCheckAt = null;
    session = {
      accessToken: response.access_token,
      refreshToken: response.refresh_token,
      expiresAtEpochMs: expiresAt(response.expires_in),
      user: {
        id: response.user.id,
        username: response.user.username,
        email: response.user.email || null,
      },
    };
    setState(signedInState("checking"));
    await persist(session);
    void checkAccess({ force: true });
  };

  const refreshNow = (): Promise<PersistedSession | null> => {
    if (refreshing) return refreshing;
    const current = session;
    if (!current) return Promise.resolve(null);
    const refreshGeneration = generation;
    const operation = (async () => {
      const exit = await run(FwaiGateway.refresh(options.gateway, current.refreshToken));
      if (refreshGeneration !== generation) return session;
      if (Exit.isSuccess(exit)) {
        // The gateway rotates the refresh token on every use; the old one is dead now.
        session = {
          ...current,
          accessToken: exit.value.access_token,
          refreshToken: exit.value.refresh_token,
          expiresAtEpochMs: expiresAt(exit.value.expires_in),
        };
        await persist(session);
        return session;
      }
      const error = Option.getOrUndefined(Exit.findErrorOption(exit));
      if (error && FwaiGateway.isPermanentFwaiRefreshFailure(error)) {
        await clearLocal("Your session ended. Sign in again.");
        return null;
      }
      throw error ?? Cause.squash(exit.cause);
    })();
    refreshing = operation;
    void operation.then(
      () => {
        if (refreshing === operation) refreshing = null;
      },
      () => {
        if (refreshing === operation) refreshing = null;
      },
    );
    return operation;
  };

  const getAccessToken = async (): Promise<string | null> => {
    if (!session) return null;
    if (session.expiresAtEpochMs !== null && now() >= session.expiresAtEpochMs - REFRESH_EARLY_MS) {
      return (await refreshNow())?.accessToken ?? null;
    }
    return session.accessToken;
  };

  const introspectWith = async (token: string) =>
    run(FwaiGateway.introspect(options.gateway, token));

  const runAccessCheck = async () => {
    const checkGeneration = generation;
    const current = () => checkGeneration === generation && state.status === "signedIn";
    const keepOrUnverified = () => {
      if (!current() || state.status !== "signedIn") return;
      if (state.access === "checking") setState(signedInState("unverified"));
    };

    let token: string | null;
    try {
      token = await getAccessToken();
    } catch (error) {
      reportBackground("refresh fwai session", error);
      keepOrUnverified();
      return;
    }
    if (!token || !current()) return;

    let exit = await introspectWith(token);
    let failure = Exit.isFailure(exit)
      ? Option.getOrUndefined(Exit.findErrorOption(exit))
      : undefined;
    if (failure?.status === 401) {
      // The access token was revoked or rotated elsewhere; one refresh decides.
      let refreshed: PersistedSession | null;
      try {
        refreshed = await refreshNow();
      } catch (error) {
        reportBackground("refresh fwai session", error);
        keepOrUnverified();
        return;
      }
      if (!refreshed || !current()) return;
      exit = await introspectWith(refreshed.accessToken);
      failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Exit.findErrorOption(exit))
        : undefined;
      if (failure?.status === 401) {
        if (current()) await clearLocal("Your session ended. Sign in again.");
        return;
      }
    }
    if (!current()) return;
    lastAccessCheckAt = now();
    if (Exit.isSuccess(exit)) {
      if (!exit.value.active) {
        await clearLocal("This account is no longer active.");
        return;
      }
      setState(signedInState(exit.value.fwai_access.allowed ? "allowed" : "denied"));
      return;
    }
    // 404 means the gateway has no introspection yet (llm_gateway#514); anything
    // else is an outage. Neither may lock the user out.
    reportBackground(
      "check fwai access",
      failure ?? (Exit.isFailure(exit) ? Cause.squash(exit.cause) : undefined),
    );
    keepOrUnverified();
  };

  const checkAccess = (checkOptions?: { readonly force?: boolean }): Promise<void> => {
    if (!session) return Promise.resolve();
    if (checking) return checking;
    if (
      !checkOptions?.force &&
      lastAccessCheckAt !== null &&
      now() - lastAccessCheckAt < ACCESS_CHECK_MIN_INTERVAL_MS
    ) {
      return Promise.resolve();
    }
    const operation = runAccessCheck().finally(() => {
      if (checking === operation) checking = null;
    });
    checking = operation;
    return operation;
  };

  const start = (): Promise<void> => {
    if (starting) return starting;
    starting = (async () => {
      let stored: string | null = null;
      try {
        stored = await options.storage.load();
      } catch (error) {
        reportBackground("load fwai session", error);
      }
      if (state.status !== "loading") return;
      const decoded = stored === null ? Option.none() : decodePersistedSession(stored);
      if (Option.isNone(decoded)) {
        setState({ status: "signedOut", error: null });
        return;
      }
      session = decoded.value;
      setState(signedInState("checking"));
      void checkAccess({ force: true });
    })();
    return starting;
  };

  const signIn = async (input: { readonly username: string; readonly password: string }) => {
    const exit = await run(
      FwaiGateway.login(options.gateway, {
        username: input.username.trim(),
        password: input.password,
        device: options.device,
      }),
    );
    if (Exit.isFailure(exit)) {
      const error = Option.getOrUndefined(Exit.findErrorOption(exit));
      setState({
        status: "signedOut",
        error: error ? FwaiGateway.describeFwaiSignInError(error) : "Sign-in failed. Try again.",
      });
      return;
    }
    if (exit.value._tag === "Session") {
      await adopt(exit.value.session);
      return;
    }
    challengeId = exit.value.challenge.challenge_id;
    setState({
      status: "codeRequired",
      emailHint: exit.value.challenge.email_hint,
      codeSent: exit.value.challenge.sent,
      error: null,
    });
  };

  const verifyCode = async (code: string) => {
    if (state.status !== "codeRequired" || challengeId === null) return;
    const pending = state;
    const exit = await run(
      FwaiGateway.verifyLogin(options.gateway, { challengeId, code: code.trim() }),
    );
    if (state !== pending) return;
    if (Exit.isSuccess(exit)) {
      await adopt(exit.value);
      return;
    }
    const error = Option.getOrUndefined(Exit.findErrorOption(exit));
    const message = error
      ? FwaiGateway.describeFwaiSignInError(error)
      : "Sign-in failed. Try again.";
    // A wrong code may be retried; every other answer means starting over.
    if (error && (error.code === "invalid_code" || error.status === undefined)) {
      setState({ ...pending, error: message });
      return;
    }
    challengeId = null;
    setState({ status: "signedOut", error: message });
  };

  const cancelCode = () => {
    if (state.status !== "codeRequired") return;
    challengeId = null;
    setState({ status: "signedOut", error: null });
  };

  const signOut = async () => {
    const current = session;
    await clearLocal();
    if (!current) return;
    const exit = await run(FwaiGateway.logout(options.gateway, current.accessToken));
    if (Exit.isFailure(exit))
      reportBackground("sign out of fwai gateway", Cause.squash(exit.cause));
  };

  const accountResources = () => ({
    user:
      state.status === "loading"
        ? undefined
        : state.status === "signedIn"
          ? { id: state.user.id }
          : null,
  });

  return {
    getState: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    addListener: (listener) => {
      const notify = () => listener(accountResources());
      listeners.add(notify);
      notify();
      return () => listeners.delete(notify);
    },
    start,
    signIn,
    verifyCode,
    cancelCode,
    signOut,
    getAccessToken,
    checkAccess,
  };
}

/** Whether the app should be usable: anything but a definite "no access". */
export function fwaiAccessPermitsUse(access: FwaiAccess): boolean {
  return access !== "denied";
}
