import * as HostProcess from "@t3tools/shared/HostProcess";
import { resolveSelfInvocation, selfInvocationArgs } from "@t3tools/shared/nodeRuntime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { fwaiGatewayConfig } from "../cloud/publicConfig.ts";
import * as CodexManagedTokenBroker from "../provider/CodexManagedTokenBroker.ts";
import { COMMAND_TIMEOUT_MS } from "../provider/CodexManagedTokenProtocol.ts";
import {
  CODEX_GATEWAY_PROVIDER_ID,
  FWAI_GATEWAY_PROJECT_ENV,
  FWAI_GATEWAY_PROJECT_HEADER,
} from "./routeEnv.ts";

export interface FwaiGatewayRoute {
  readonly gatewayUrl: string;
  readonly tokenCommand: string;
  readonly tokenArgs: ReadonlyArray<string>;
}

/**
 * None when the gateway config or the private token listener is unavailable (tests, CLI-only
 * hosts); routing then cannot authenticate and the instance runs unrouted.
 */
export const resolveFwaiGatewayRoute = Effect.fn("FwaiGatewayRoute.resolve")(function* () {
  const broker = yield* Effect.serviceOption(CodexManagedTokenBroker.CodexManagedTokenBroker);
  const identity = yield* Effect.serviceOption(ServerEnvironment.ServerEnvironmentIdentity);
  if (Option.isNone(broker) || Option.isNone(identity)) return Option.none<FwaiGatewayRoute>();
  const endpoint = yield* broker.value.endpoint.pipe(Effect.option);
  const config = yield* Effect.option(fwaiGatewayConfig);
  if (Option.isNone(endpoint) || Option.isNone(config)) return Option.none<FwaiGatewayRoute>();
  const environmentId = yield* identity.value.getEnvironmentId;
  const invocation = yield* resolveSelfInvocation();
  return Option.some<FwaiGatewayRoute>({
    gatewayUrl: config.value.gatewayUrl,
    tokenCommand: invocation.command,
    tokenArgs: selfInvocationArgs(invocation, [
      "__fwai-gateway-token",
      endpoint.value,
      environmentId,
    ]),
  });
});

const quotePosix = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;
const quoteWindows = (value: string) => `"${value.replaceAll('"', '""')}"`;

/**
 * Flag settings outrank the user's settings.json, so a token another tool wrote there (fwai_app's
 * forwarding writes ANTHROPIC_AUTH_TOKEN) cannot replace the helper's. Claude sends
 * ANTHROPIC_AUTH_TOKEN ahead of the helper's key unless it is blanked.
 */
export const claudeGatewaySettings = Effect.fn("FwaiGatewayRoute.claudeSettings")(function* (
  route: FwaiGatewayRoute,
) {
  const windows = (yield* HostProcess.Platform) === "win32";
  const quote = windows ? quoteWindows : quotePosix;
  const command = [route.tokenCommand, ...route.tokenArgs].map(quote).join(" ");
  return {
    // Claude runs the helper through a shell; under Electron the binary must start as Node.
    apiKeyHelper: windows ? command : `ELECTRON_RUN_AS_NODE=1 ${command}`,
    env: {
      ANTHROPIC_BASE_URL: route.gatewayUrl,
      ANTHROPIC_AUTH_TOKEN: "",
      ANTHROPIC_API_KEY: "",
    },
  };
});

/** Adds the quota project header to Claude's gateway flag settings; the gateway checks membership. */
export const withFwaiGatewayProject = <S extends { readonly env?: Record<string, string> }>(
  settings: S,
  projectId: string | null,
): S =>
  projectId === null
    ? settings
    : {
        ...settings,
        env: {
          ...settings.env,
          ANTHROPIC_CUSTOM_HEADERS: `${FWAI_GATEWAY_PROJECT_HEADER}: ${projectId}`,
        },
      };

/**
 * Defines the gateway provider on every Codex launch, routed or not, so threads started through
 * the gateway still resume after routing is turned off. Custom providers skip the Responses
 * WebSocket, which the gateway does not serve.
 */
export const codexGatewayLaunchArgs = (route: FwaiGatewayRoute) =>
  `-c ${JSON.stringify(
    `model_providers.${CODEX_GATEWAY_PROVIDER_ID}={name="fwai Gateway",base_url=${JSON.stringify(
      `${route.gatewayUrl}/v1`,
    )},wire_api="responses",requires_openai_auth=false,supports_websockets=false,env_http_headers={${JSON.stringify(
      FWAI_GATEWAY_PROJECT_HEADER,
    )}=${JSON.stringify(FWAI_GATEWAY_PROJECT_ENV)}},auth={command=${JSON.stringify(
      route.tokenCommand,
    )},args=${JSON.stringify(route.tokenArgs)},timeout_ms=${COMMAND_TIMEOUT_MS},refresh_interval_ms=0}}`,
  )}`;
