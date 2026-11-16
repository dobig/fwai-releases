import {
  type FakeFwaiGatewayReply,
  type FakeFwaiGatewayRequest,
  makeFakeFwaiGateway,
} from "@t3tools/shared/testing/fwaiGatewayFake";
import { describe, expect, it } from "vite-plus/test";

import { createFwaiAccountSession, type FwaiAccountStorage } from "./fwaiAccountSession.ts";

const user = { id: "user_1", username: "ada", email: "ada@example.test" };

function loginBody(index: number, expiresIn = 0) {
  return {
    token_type: "Bearer",
    access_token: `access-${index}`,
    refresh_token: `refresh-${index}`,
    expires_in: expiresIn,
    installation_id: "inst_1",
    user,
  };
}

const allowed = {
  active: true,
  sub: "user_1",
  fwai_access: { allowed: true, via: "plan" },
};

function memoryStorage(initial: string | null = null) {
  let value = initial;
  const storage: FwaiAccountStorage = {
    load: async () => value,
    save: async (next) => {
      value = next;
    },
    clear: async () => {
      value = null;
    },
  };
  return { storage, read: () => value };
}

function setup(
  handle: (request: FakeFwaiGatewayRequest) => FakeFwaiGatewayReply | "transport-error",
  stored: string | null = null,
) {
  let clock = 1_000_000;
  const gateway = makeFakeFwaiGateway(handle);
  const memory = memoryStorage(stored);
  const session = createFwaiAccountSession({
    gateway: { gatewayUrl: "https://gateway.test", clientId: "fwai" },
    device: { deviceName: "laptop", platform: "web", appVersion: "0.1.0" },
    storage: memory.storage,
    httpClient: gateway.layer,
    now: () => clock,
  });
  return {
    session,
    gateway,
    memory,
    advance: (ms: number) => {
      clock += ms;
    },
    paths: () => gateway.requests.map((request) => request.path),
  };
}

describe("createFwaiAccountSession", () => {
  it("signs in, stores the session and checks fwai access", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/login"
        ? { status: 200, body: loginBody(1) }
        : { status: 200, body: allowed },
    );
    await t.session.start();
    expect(t.session.getState()).toEqual({ status: "signedOut", error: null });

    await t.session.signIn({ username: " ada ", password: "pw" });
    await t.session.checkAccess();

    expect(t.session.getState()).toEqual({
      status: "signedIn",
      user: { id: "user_1", username: "ada", email: "ada@example.test" },
      access: "allowed",
    });
    expect(t.gateway.requests[0]?.body).toMatchObject({ username: "ada", client_id: "fwai" });
    expect(t.gateway.requests[1]).toMatchObject({
      path: "/v1/auth/introspect",
      authorization: "Bearer access-1",
    });
    expect(JSON.parse(t.memory.read() ?? "null")).toMatchObject({
      accessToken: "access-1",
      refreshToken: "refresh-1",
      expiresAtEpochMs: null,
    });
  });

  it("completes a two-step login after a wrong code", async () => {
    const t = setup((request) => {
      switch (request.path) {
        case "/v1/auth/login":
          return {
            status: 409,
            body: {
              error: "email_code_required",
              challenge_id: "lch_1",
              email_hint: "a***@example.test",
              expires_in: 600,
              sent: true,
            },
          };
        case "/v1/auth/login/verify":
          return (request.body as { code: string }).code === "111111"
            ? { status: 200, body: loginBody(1) }
            : { status: 400, body: { error: "invalid_code" } };
        default:
          return { status: 200, body: allowed };
      }
    });
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    expect(t.session.getState()).toEqual({
      status: "codeRequired",
      emailHint: "a***@example.test",
      codeSent: true,
      error: null,
    });

    await t.session.verifyCode("000000");
    expect(t.session.getState()).toMatchObject({
      status: "codeRequired",
      error: "Incorrect code.",
    });

    await t.session.verifyCode("111111");
    await t.session.checkAccess();
    expect(t.session.getState()).toMatchObject({ status: "signedIn", access: "allowed" });
    expect(t.gateway.requests[2]?.body).toEqual({ challenge_id: "lch_1", code: "111111" });
  });

  it("returns to the password form when the challenge expires", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/login"
        ? {
            status: 409,
            body: {
              error: "email_code_required",
              challenge_id: "lch_1",
              email_hint: "a***@example.test",
              expires_in: 600,
              sent: false,
            },
          }
        : { status: 410, body: { error: "challenge_expired" } },
    );
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.verifyCode("111111");
    expect(t.session.getState()).toEqual({
      status: "signedOut",
      error: "The code expired. Sign in again.",
    });
  });

  it("shows why a sign-in failed", async () => {
    const t = setup(() => ({ status: 401, body: { error: "invalid_credentials" } }));
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "wrong" });
    expect(t.session.getState()).toEqual({
      status: "signedOut",
      error: "Incorrect username or password.",
    });
  });

  it("refreshes once for concurrent readers and stores the rotated refresh token", async () => {
    let refreshes = 0;
    const t = setup((request) => {
      if (request.path === "/v1/auth/login") return { status: 200, body: loginBody(1, 3_600) };
      if (request.path === "/oauth/token") {
        refreshes += 1;
        return { status: 200, body: { ...loginBody(refreshes + 1, 3_600), user: undefined } };
      }
      return { status: 200, body: allowed };
    });
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();
    expect(await t.session.getAccessToken()).toBe("access-1");

    t.advance(3_600_000);
    const tokens = await Promise.all([t.session.getAccessToken(), t.session.getAccessToken()]);
    expect(tokens).toEqual(["access-2", "access-2"]);
    expect(refreshes).toBe(1);

    t.advance(3_600_000);
    expect(await t.session.getAccessToken()).toBe("access-3");
    const refreshBodies = t.gateway.requests
      .filter((request) => request.path === "/oauth/token")
      .map((request) => request.body);
    expect(refreshBodies).toEqual([
      { grant_type: "refresh_token", refresh_token: "refresh-1" },
      { grant_type: "refresh_token", refresh_token: "refresh-2" },
    ]);
    expect(JSON.parse(t.memory.read() ?? "null")).toMatchObject({ refreshToken: "refresh-3" });
  });

  it("signs out when the refresh token is rejected", async () => {
    const t = setup((request) => {
      if (request.path === "/v1/auth/login") return { status: 200, body: loginBody(1, 60) };
      if (request.path === "/oauth/token") {
        return { status: 401, body: { error: "invalid_refresh_token" } };
      }
      return { status: 200, body: allowed };
    });
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();

    t.advance(60_000);
    expect(await t.session.getAccessToken()).toBeNull();
    expect(t.session.getState()).toEqual({
      status: "signedOut",
      error: "Your session ended. Sign in again.",
    });
    expect(t.memory.read()).toBeNull();
  });

  it("keeps the session when a refresh fails in transit", async () => {
    const t = setup((request) => {
      if (request.path === "/v1/auth/login") return { status: 200, body: loginBody(1, 60) };
      if (request.path === "/oauth/token") return "transport-error";
      return { status: 200, body: allowed };
    });
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();

    t.advance(60_000);
    await expect(t.session.getAccessToken()).rejects.toMatchObject({ _tag: "FwaiGatewayError" });
    expect(t.session.getState()).toMatchObject({ status: "signedIn" });
  });

  it("marks the account as needing a subscription when fwai access is not allowed", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/login"
        ? { status: 200, body: loginBody(1) }
        : { status: 200, body: { active: true, sub: "user_1", fwai_access: { allowed: false } } },
    );
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();
    expect(t.session.getState()).toMatchObject({ status: "signedIn", access: "denied" });
  });

  it("signs out when introspection reports the account inactive", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/introspect"
        ? { status: 200, body: { active: false, fwai_access: { allowed: false, via: null } } }
        : { status: 200, body: loginBody(1) },
    );
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();
    expect(t.session.getState()).toEqual({
      status: "signedOut",
      error: "This account is no longer active.",
    });
  });

  it("does not lock users out while the gateway has no introspection endpoint", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/introspect"
        ? { status: 404, body: { error: "not_found" } }
        : { status: 200, body: loginBody(1) },
    );
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();
    expect(t.session.getState()).toMatchObject({ status: "signedIn", access: "unverified" });
  });

  it("refreshes and retries introspection once after a 401", async () => {
    let introspections = 0;
    const t = setup((request) => {
      if (request.path === "/v1/auth/login") return { status: 200, body: loginBody(1) };
      if (request.path === "/oauth/token") return { status: 200, body: loginBody(2) };
      introspections += 1;
      return introspections === 1
        ? { status: 401, body: { error: "invalid_token" } }
        : {
            status: 200,
            body: allowed,
          };
    });
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();
    expect(t.session.getState()).toMatchObject({ status: "signedIn", access: "allowed" });
    expect(t.gateway.requests.at(-1)?.authorization).toBe("Bearer access-2");
  });

  it("restores a stored session and re-checks access on foreground at most every 30s", async () => {
    const stored = JSON.stringify({
      accessToken: "access-9",
      refreshToken: "refresh-9",
      expiresAtEpochMs: null,
      user: { id: "user_1", username: "ada", email: null },
    });
    const t = setup(() => ({ status: 200, body: allowed }), stored);
    await t.session.start();
    await t.session.checkAccess();
    expect(t.session.getState()).toMatchObject({ status: "signedIn", access: "allowed" });

    await t.session.checkAccess();
    t.advance(30_000);
    await t.session.checkAccess();
    expect(t.paths()).toEqual(["/v1/auth/introspect", "/v1/auth/introspect"]);
  });

  it("reports the signed-in account to the cloud account service", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/login"
        ? { status: 200, body: loginBody(1) }
        : { status: 200, body: allowed },
    );
    const seen: Array<string | null | undefined> = [];
    const remove = t.session.addListener((resources) =>
      seen.push(resources.user === undefined ? undefined : (resources.user?.id ?? null)),
    );
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.signOut();
    remove();

    expect(seen[0]).toBeUndefined();
    expect(seen).toContain("user_1");
    expect(seen.at(-1)).toBeNull();
  });

  it("revokes the gateway session and clears storage on sign-out", async () => {
    const t = setup((request) =>
      request.path === "/v1/auth/login"
        ? { status: 200, body: loginBody(1) }
        : request.path === "/v1/account/logout"
          ? { status: 204 }
          : { status: 200, body: allowed },
    );
    await t.session.start();
    await t.session.signIn({ username: "ada", password: "pw" });
    await t.session.checkAccess();
    await t.session.signOut();

    expect(t.gateway.requests.at(-1)).toMatchObject({
      method: "POST",
      path: "/v1/account/logout",
      authorization: "Bearer access-1",
    });
    expect(t.memory.read()).toBeNull();
    expect(t.session.getState()).toEqual({ status: "signedOut", error: null });
    expect(await t.session.getAccessToken()).toBeNull();
  });
});
