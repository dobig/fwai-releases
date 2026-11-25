import type { FwaiAttestationReport, OrchestrationV2ProviderThread } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "vite-plus/test";

import {
  fwaiGatewayRouteOf,
  fwaiSignInAgainNotice,
  syncFwaiEnvironmentAttestation,
  threadRoutesThroughGateway,
} from "./fwaiGateway.ts";

const thread = (driver: string, modelProviderId?: string) =>
  ({
    driver,
    ...(modelProviderId === undefined ? {} : { nativeMetadata: { modelProviderId } }),
  }) as unknown as OrchestrationV2ProviderThread;

describe("fwaiGatewayRouteOf", () => {
  it("reads the provider a Codex thread started on", () => {
    expect(fwaiGatewayRouteOf(thread("codex", "fwai_gateway"))).toBe("gateway");
    expect(fwaiGatewayRouteOf(thread("codex", "openai"))).toBe("direct");
  });

  it("claims nothing for other providers or threads from before the provider was recorded", () => {
    expect(fwaiGatewayRouteOf(thread("claudeAgent", "fwai_gateway"))).toBeNull();
    expect(fwaiGatewayRouteOf(thread("codex"))).toBeNull();
    expect(fwaiGatewayRouteOf(undefined)).toBeNull();
  });
});

describe("threadRoutesThroughGateway", () => {
  const on = { fwaiGatewayEnabled: true, fwaiGatewayClaude: true, fwaiGatewayCodex: false };

  it("follows the per-provider switch, and Codex threads keep their starting route", () => {
    expect(threadRoutesThroughGateway(on, { driver: "claudeAgent", codexRoute: null })).toBe(true);
    expect(threadRoutesThroughGateway(on, { driver: "codex", codexRoute: null })).toBe(false);
    expect(threadRoutesThroughGateway(on, { driver: "codex", codexRoute: "gateway" })).toBe(true);
  });

  it("routes nothing while the gateway is off", () => {
    const off = { ...on, fwaiGatewayEnabled: false };
    expect(threadRoutesThroughGateway(off, { driver: "codex", codexRoute: "gateway" })).toBe(false);
  });
});

describe("syncFwaiEnvironmentAttestation", () => {
  const registrationFor = (publicKey: string) => ({
    environmentId: "env-1",
    publicKey,
    name: "laptop",
  });

  const harness = (replies: Array<{ status: number; body: unknown }>, signedIn = true) => {
    const posted: unknown[] = [];
    const reports: FwaiAttestationReport[] = [];
    const keys = ["key-1", "key-2"];
    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        if (request.body._tag === "Uint8Array") {
          posted.push({
            url: request.url,
            body: JSON.parse(new TextDecoder().decode(request.body.body)),
          });
        }
        const reply = replies.shift() ?? { status: 500, body: {} };
        return HttpClientResponse.fromWeb(request, Response.json(reply.body, reply));
      }),
    );
    const options = {
      gateway: { gatewayUrl: "https://gateway.test", clientId: "fwai" },
      getAccessToken: async () => (signedIn ? "account-token" : null),
      httpClient: Layer.succeed(HttpClient.HttpClient, http),
    };
    const environment = {
      registration: async () => registrationFor(keys[0]!),
      report: async (report: FwaiAttestationReport) => {
        reports.push(report);
        if (report.outcome.status === "key-rejected") keys.shift();
      },
    };
    return { posted, reports, run: () => syncFwaiEnvironmentAttestation(options, environment) };
  };

  it("registers the environment's key with the account and reports the expiry", async () => {
    const h = harness([
      {
        status: 200,
        body: {
          kid: "k",
          environment_id: "env-1",
          expires_at: "2026-12-25T00:00:00Z",
          status: "current",
        },
      },
    ]);
    await h.run();
    expect(h.posted).toEqual([
      {
        url: "https://gateway.test/v1/me/fwai/environments",
        body: { environment_id: "env-1", public_key: "key-1", name: "laptop" },
      },
    ]);
    expect(h.reports).toEqual([
      {
        publicKey: "key-1",
        outcome: { status: "registered", expiresAt: "2026-12-25T00:00:00Z" },
      },
    ]);
  });

  it.each(["key_revoked", "key_in_use"])(
    "replaces a key rejected with %s and registers the new one in the same connect",
    async (code) => {
      const h = harness([
        { status: 409, body: { error: code } },
        {
          status: 200,
          body: {
            kid: "k2",
            environment_id: "env-1",
            expires_at: "2026-12-25T00:00:00Z",
            status: "current",
          },
        },
      ]);
      await h.run();
      expect(h.reports.map((report) => [report.publicKey, report.outcome.status])).toEqual([
        ["key-1", "key-rejected"],
        ["key-2", "registered"],
      ]);
    },
  );

  it("does not take a key kept in its grace period for a registration", async () => {
    const h = harness([
      {
        status: 200,
        body: {
          kid: "k",
          environment_id: "env-1",
          expires_at: "2026-12-25T00:00:00Z",
          status: "grace",
        },
      },
    ]);
    await h.run();
    expect(h.reports).toEqual([]);
  });

  it("asks the account to sign in again on sign_in_again, and clears once a session may register", async () => {
    fwaiSignInAgainNotice.clear();
    const refused = harness([{ status: 403, body: { error: "sign_in_again" } }]);
    await refused.run();
    expect(refused.reports).toEqual([]);
    expect(fwaiSignInAgainNotice.get()).toBe(true);

    // A plain scope refusal is not the account's to fix, so the notice stays as it was.
    await harness([{ status: 403, body: { error: "insufficient_scope", scope: "fwai" } }]).run();
    expect(fwaiSignInAgainNotice.get()).toBe(true);

    // After signing in again the new session registers and the notice goes away.
    const renewed = harness([
      {
        status: 200,
        body: {
          kid: "k",
          environment_id: "env-1",
          expires_at: "2026-12-25T00:00:00Z",
          status: "current",
        },
      },
    ]);
    await renewed.run();
    expect(renewed.reports).toHaveLength(1);
    expect(fwaiSignInAgainNotice.get()).toBe(false);
  });

  it("treats a gateway without the endpoint, or no account, as nothing to do", async () => {
    for (const reply of [
      { status: 404, body: { error: "not_found" } },
      // An account session from before the scope split, or a device-code session, may not register.
      { status: 403, body: { error: "insufficient_scope" } },
      { status: 400, body: { error: "invalid_request" } },
    ]) {
      const refused = harness([reply]);
      await refused.run();
      expect(refused.posted).toHaveLength(1);
      expect(refused.reports).toEqual([]);
    }

    const signedOut = harness([], false);
    await signedOut.run();
    expect(signedOut.posted).toEqual([]);
    expect(signedOut.reports).toEqual([]);
  });
});
