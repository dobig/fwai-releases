import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as FwaiGateway from "./fwaiGateway.ts";
import { makeFakeFwaiGateway } from "./testing/fwaiGatewayFake.ts";

const config = { gatewayUrl: "https://gateway.test", clientId: "fwai" } as const;
const device = { deviceName: "laptop", platform: "macos", appVersion: "0.1.0" } as const;

const session = {
  token_type: "Bearer",
  access_token: "access-1",
  refresh_token: "refresh-1",
  expires_in: 0,
  installation_id: "inst_1",
  user: { id: "user_1", username: "ada", email: "ada@example.test" },
};

describe("fwaiGateway", () => {
  it.effect("signs in with client_id fwai and returns the session", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => ({ status: 200, body: session }));
      const result = yield* FwaiGateway.login(config, {
        username: "ada@example.test",
        password: "pw",
        device,
      }).pipe(Effect.provide(gateway.layer));

      expect(result).toEqual({ _tag: "Session", session });
      expect(gateway.requests).toEqual([
        {
          method: "POST",
          path: "/v1/auth/login",
          authorization: undefined,
          body: {
            username: "ada@example.test",
            password: "pw",
            device_name: "laptop",
            platform: "macos",
            app_version: "0.1.0",
            client_id: "fwai",
          },
        },
      ]);
    }),
  );

  it.effect("returns the email-code challenge on 409 and completes it with the code", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway((request) =>
        request.path === "/v1/auth/login"
          ? {
              status: 409,
              body: {
                error: "email_code_required",
                challenge_id: "lch_1",
                email_hint: "a***@example.test",
                expires_in: 600,
                sent: true,
              },
            }
          : { status: 200, body: session },
      );
      const first = yield* FwaiGateway.login(config, {
        username: "ada",
        password: "pw",
        device,
      }).pipe(Effect.provide(gateway.layer));
      expect(first._tag).toBe("EmailCodeRequired");
      if (first._tag !== "EmailCodeRequired") return;

      const verified = yield* FwaiGateway.verifyLogin(config, {
        challengeId: first.challenge.challenge_id,
        code: "123456",
      }).pipe(Effect.provide(gateway.layer));

      expect(verified.access_token).toBe("access-1");
      expect(gateway.requests[1]).toMatchObject({
        path: "/v1/auth/login/verify",
        body: { challenge_id: "lch_1", code: "123456" },
      });
    }),
  );

  it.effect("surfaces gateway error codes and retry hints", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => ({
        status: 429,
        body: { error: "too_many_attempts", retry_after: 30 },
      }));
      const error = yield* FwaiGateway.login(config, {
        username: "ada",
        password: "x",
        device,
      }).pipe(Effect.provide(gateway.layer), Effect.flip);
      expect(error).toMatchObject({
        status: 429,
        code: "too_many_attempts",
        retryAfterSeconds: 30,
      });
      expect(FwaiGateway.describeFwaiSignInError(error)).toBe(
        "Too many attempts. Try again in 30 seconds.",
      );
    }),
  );

  it.effect("reports an unreachable gateway without a status", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => "transport-error");
      const error = yield* FwaiGateway.refresh(config, "refresh-1").pipe(
        Effect.provide(gateway.layer),
        Effect.flip,
      );
      expect(error.status).toBeUndefined();
      expect(FwaiGateway.isPermanentFwaiRefreshFailure(error)).toBe(false);
    }),
  );

  it.effect("treats a rejected refresh token as permanent", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => ({
        status: 401,
        body: { error: "invalid_refresh_token" },
      }));
      const error = yield* FwaiGateway.refresh(config, "refresh-1").pipe(
        Effect.provide(gateway.layer),
        Effect.flip,
      );
      expect(FwaiGateway.isPermanentFwaiRefreshFailure(error)).toBe(true);
      expect(gateway.requests[0]?.body).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-1",
      });
    }),
  );

  it.effect("sends the bearer token to introspect and decodes fwai access", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => ({
        status: 200,
        body: {
          active: true,
          sub: "user_1",
          client_id: "fwai",
          scopes: ["account", "fwai"],
          user_status: "active",
          fwai_access: { allowed: false, via: null },
        },
      }));
      const result = yield* FwaiGateway.introspect(config, "access-1").pipe(
        Effect.provide(gateway.layer),
      );
      expect(gateway.requests[0]).toMatchObject({
        method: "GET",
        path: "/v1/auth/introspect",
        authorization: "Bearer access-1",
      });
      expect(FwaiGateway.introspectionAllowsFwai(result)).toBe(false);
      expect(
        FwaiGateway.introspectionAllowsFwai({ ...result, fwai_access: { allowed: true } }),
      ).toBe(true);
      expect(
        FwaiGateway.introspectionAllowsFwai({
          ...result,
          active: false,
          fwai_access: { allowed: true },
        }),
      ).toBe(false);
    }),
  );

  it.effect("decodes the organization, treating a missing project member flag as unknown", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => ({
        status: 200,
        body: {
          organization: { id: "org_1", name: "Acme", role: "owner", plan: "team" },
          projects: [
            { id: "prj_1", name: "Web", member: false },
            { id: "prj_2", name: "Api" },
          ],
        },
      }));
      const result = yield* FwaiGateway.getOrganization(config, "access-1").pipe(
        Effect.provide(gateway.layer),
      );
      expect(gateway.requests[0]).toMatchObject({
        method: "GET",
        path: "/v1/me/organization",
        authorization: "Bearer access-1",
      });
      expect(result).toEqual({
        organization: { id: "org_1", name: "Acme", role: "owner" },
        projects: [
          { id: "prj_1", name: "Web", member: false },
          { id: "prj_2", name: "Api" },
        ],
      });
    }),
  );

  it.effect("queries the members directory and surfaces its error codes", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway((request) =>
        request.path.includes("project_id=prj_9")
          ? { status: 404, body: { error: "project_not_found" } }
          : {
              status: 200,
              body: {
                members: [
                  { user_id: "usr_2", username: "bob", role: "member", project_ids: ["prj_1"] },
                ],
                next_cursor: "c2",
              },
            },
      );
      const page = yield* FwaiGateway.listOrganizationMembers(config, "access-1", {
        q: "bo",
        ids: ["usr_2", "usr_3"],
        limit: 20,
      }).pipe(Effect.provide(gateway.layer));
      expect(gateway.requests[0]?.path).toBe(
        "/v1/me/organization/members?q=bo&ids=usr_2%2Cusr_3&limit=20",
      );
      expect(page).toEqual({
        members: [{ user_id: "usr_2", username: "bob", role: "member", project_ids: ["prj_1"] }],
        next_cursor: "c2",
      });

      const error = yield* FwaiGateway.listOrganizationMembers(config, "access-1", {
        projectId: "prj_9",
      }).pipe(Effect.provide(gateway.layer), Effect.flip);
      expect(error).toMatchObject({
        operation: "organizationMembers",
        status: 404,
        code: "project_not_found",
      });
    }),
  );

  it.effect("sends only CORS-safelisted headers plus authorization", () =>
    Effect.gen(function* () {
      const gateway = makeFakeFwaiGateway(() => ({ status: 200, body: session }));
      yield* FwaiGateway.introspect(config, "access-1").pipe(
        Effect.ignore,
        Effect.withSpan("caller"),
        Effect.provide(gateway.layer),
      );
      // The gateway's preflight allows Authorization and Content-Type only;
      // trace headers (b3, traceparent) would fail it in browsers.
      expect(gateway.headerNames[0]).toEqual(["accept", "authorization"]);
    }),
  );

  it.effect("maps device-token poll replies to pending, slow down, token and failures", () =>
    Effect.gen(function* () {
      const replies = [
        { status: 400, body: { error: "authorization_pending" } },
        { status: 400, body: { error: "slow_down" } },
        {
          status: 200,
          body: { token_type: "Bearer", access_token: "a", refresh_token: "r", expires_in: 0 },
        },
        { status: 400, body: { error: "access_denied" } },
      ];
      const gateway = makeFakeFwaiGateway(() => replies.shift() ?? { status: 500 });
      const poll = FwaiGateway.pollDeviceToken(config, "device-1").pipe(
        Effect.provide(gateway.layer),
      );
      expect(yield* poll).toEqual({ _tag: "Pending" });
      expect(yield* poll).toEqual({ _tag: "SlowDown" });
      expect((yield* poll)._tag).toBe("Token");
      expect(yield* Effect.flip(poll)).toMatchObject({ code: "access_denied" });
      expect(gateway.requests[0]?.body).toEqual({
        grant_type: FwaiGateway.FWAI_DEVICE_CODE_GRANT_TYPE,
        device_code: "device-1",
        client_id: "fwai",
      });
    }),
  );

  it("normalizes gateway URLs to https origins, allowing http only on loopback", () => {
    expect(FwaiGateway.normalizeFwaiGatewayUrl("https://api.fwai.space/")).toBe(
      "https://api.fwai.space",
    );
    expect(FwaiGateway.normalizeFwaiGatewayUrl("http://localhost:8080")).toBe(
      "http://localhost:8080",
    );
    expect(FwaiGateway.normalizeFwaiGatewayUrl("http://api.fwai.space")).toBeNull();
    expect(FwaiGateway.normalizeFwaiGatewayUrl("")).toBeNull();
  });
});
