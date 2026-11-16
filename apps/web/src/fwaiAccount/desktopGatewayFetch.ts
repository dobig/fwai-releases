import type { DesktopFwaiGatewayRequest, DesktopFwaiGatewayResponse } from "@t3tools/contracts";

// Statuses whose Response must be constructed without a body.
const NULL_BODY_STATUSES = new Set([101, 103, 204, 205, 304]);

/**
 * A `fetch` that sends each request through the desktop main process, because the
 * renderer's custom-scheme origin is not on the gateway's CORS allowlist.
 */
export function makeDesktopGatewayFetch(
  send: (request: DesktopFwaiGatewayRequest) => Promise<DesktopFwaiGatewayResponse>,
): typeof globalThis.fetch {
  const desktopFetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    request.signal.throwIfAborted();
    const body = request.method === "GET" || request.method === "HEAD" ? "" : await request.text();
    const response = await send({
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers),
      body: body === "" ? null : body,
    });
    return new Response(NULL_BODY_STATUSES.has(response.status) ? null : response.body, {
      status: response.status,
      headers: response.headers,
    });
  };
  return desktopFetch as typeof globalThis.fetch;
}
