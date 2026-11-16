import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

const decodeJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));

export interface FakeFwaiGatewayRequest {
  readonly method: string;
  /** Path and query, e.g. `/oauth/token`. */
  readonly path: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface FakeFwaiGatewayReply {
  readonly status: number;
  readonly body?: unknown;
}

/**
 * An in-memory llm_gateway for tests. `handle` answers each request; returning
 * `"transport-error"` makes the request fail as if the gateway were unreachable.
 */
export function makeFakeFwaiGateway(
  handle: (request: FakeFwaiGatewayRequest) => FakeFwaiGatewayReply | "transport-error",
) {
  const requests: Array<FakeFwaiGatewayRequest> = [];
  const headerNames: Array<ReadonlyArray<string>> = [];
  const client = HttpClient.make((request) =>
    Effect.suspend(() => {
      const url = new URL(request.url);
      const rawBody =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const recorded: FakeFwaiGatewayRequest = {
        method: request.method,
        path: `${url.pathname}${url.search}`,
        authorization: request.headers.authorization,
        body: rawBody ? decodeJson(rawBody) : undefined,
      };
      requests.push(recorded);
      headerNames.push(Object.keys(request.headers).sort());
      const reply = handle(recorded);
      if (reply === "transport-error") {
        return Effect.fail(
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: "fake gateway unreachable",
            }),
          }),
        );
      }
      return Effect.succeed(
        HttpClientResponse.fromWeb(
          request,
          reply.body === undefined
            ? new Response(null, { status: reply.status })
            : Response.json(reply.body, { status: reply.status }),
        ),
      );
    }),
  );
  return { requests, headerNames, layer: Layer.succeed(HttpClient.HttpClient, client) };
}
