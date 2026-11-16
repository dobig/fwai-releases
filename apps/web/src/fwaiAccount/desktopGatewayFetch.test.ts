import type { DesktopFwaiGatewayRequest } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { makeDesktopGatewayFetch } from "./desktopGatewayFetch";

describe("makeDesktopGatewayFetch", () => {
  it("forwards the request over the bridge and rebuilds the response", async () => {
    const send = vi.fn(async (_request: DesktopFwaiGatewayRequest) => ({
      status: 401,
      headers: { "content-type": "application/json" },
      body: '{"error":"invalid_credentials"}',
    }));
    const desktopFetch = makeDesktopGatewayFetch(send);

    const response = await desktopFetch("https://api.example.com/v1/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: new TextEncoder().encode('{"username":"ada"}'),
    });

    expect(send).toHaveBeenCalledWith({
      url: "https://api.example.com/v1/auth/login",
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer token" },
      body: '{"username":"ada"}',
    });
    expect(response.status).toBe(401);
    expect(response.headers.get("content-type")).toBe("application/json");
    expect(await response.json()).toEqual({ error: "invalid_credentials" });
  });

  it("sends no body for GET and accepts empty responses", async () => {
    const send = vi.fn(async (_request: DesktopFwaiGatewayRequest) => ({
      status: 204,
      headers: {},
      body: "",
    }));

    const response = await makeDesktopGatewayFetch(send)(
      "https://api.example.com/v1/auth/introspect",
    );

    expect(send.mock.calls[0]?.[0]).toMatchObject({ method: "GET", body: null });
    expect(response.status).toBe(204);
    expect(await response.text()).toBe("");
  });

  it("rejects without calling the bridge when the request is already aborted", async () => {
    const send = vi.fn();
    const controller = new AbortController();
    controller.abort();

    await expect(
      makeDesktopGatewayFetch(send)("https://api.example.com/v1/auth/logout", {
        method: "POST",
        signal: controller.signal,
      }),
    ).rejects.toThrow();
    expect(send).not.toHaveBeenCalled();
  });
});
