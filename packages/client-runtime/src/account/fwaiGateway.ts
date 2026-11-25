import type {
  FwaiAttestationRegistration,
  FwaiAttestationReport,
  OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import * as FwaiGateway from "@t3tools/shared/fwaiGateway";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type * as Layer from "effect/Layer";
import type * as HttpClient from "effect/http/HttpClient";

/**
 * Client side of fwai Gateway routing, shared by web and mobile: the signed-in account approves
 * an environment's sign-in, and reads plan and organization project quota for display.
 */
export interface FwaiGatewayClientOptions {
  readonly gateway: FwaiGateway.FwaiGatewayConfig;
  readonly getAccessToken: () => Promise<string | null>;
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
}

/** The provider id Codex threads routed through fwai Gateway start on (see the server's route). */
const CODEX_GATEWAY_PROVIDER_ID = "fwai_gateway";

export type FwaiGatewayThreadRoute = "gateway" | "direct";

/** Null for non-Codex threads and for Codex threads started before fwai recorded the provider. */
export function fwaiGatewayRouteOf(
  providerThread: OrchestrationV2ProviderThread | undefined,
): FwaiGatewayThreadRoute | null {
  if (providerThread?.driver !== "codex") return null;
  const providerId = providerThread.nativeMetadata?.modelProviderId;
  if (providerId === undefined) return null;
  return providerId === CODEX_GATEWAY_PROVIDER_ID ? "gateway" : "direct";
}

/**
 * Approves an environment's fwai Gateway sign-in code with this app's own account, so turning on
 * gateway routing never asks the user to sign in again. Rejects when no account is signed in.
 */
export async function approveFwaiDeviceCode(
  options: FwaiGatewayClientOptions,
  userCode: string,
): Promise<void> {
  const accessToken = await options.getAccessToken();
  if (accessToken === null) throw new Error("Sign in to fwai first.");
  await Effect.runPromise(
    FwaiGateway.approveDeviceCode(options.gateway, accessToken, userCode).pipe(
      Effect.provide(options.httpClient),
    ),
  );
}

let signInAgain = false;
const signInAgainListeners = new Set<() => void>();
const setSignInAgain = (value: boolean) => {
  if (signInAgain === value) return;
  signInAgain = value;
  for (const listener of signInAgainListeners) listener();
};

/**
 * True while the gateway refuses to register environment keys until this account signs in
 * again (its session predates device approval). The account card shows it; signing out clears it.
 */
export const fwaiSignInAgainNotice = {
  get: () => signInAgain,
  subscribe: (listener: () => void) => {
    signInAgainListeners.add(listener);
    return () => {
      signInAgainListeners.delete(listener);
    };
  },
  clear: () => setSignInAgain(false),
};

/** The environment side of attestation key registration: the server's two RPCs. */
export interface FwaiAttestationEnvironment {
  readonly registration: () => Promise<FwaiAttestationRegistration | null>;
  readonly report: (report: FwaiAttestationReport) => Promise<void>;
}

/**
 * Registers a connected environment's attestation key under this app's account (llm_gateway#760)
 * on every connect; a rejected key is replaced at once. Never throws: when the gateway cannot
 * register it (signed out, unreachable, no endpoint yet, 403) the environment sends no header.
 */
export async function syncFwaiEnvironmentAttestation(
  options: FwaiGatewayClientOptions,
  environment: FwaiAttestationEnvironment,
): Promise<void> {
  // A rejected key is replaced once per connect; the replacement registers on the second pass.
  for (let attempt = 0; attempt < 2; attempt++) {
    const accessToken = await options.getAccessToken();
    if (accessToken === null) return;
    const registration = await environment.registration();
    if (registration === null) return;
    const result = await Effect.runPromise(
      FwaiGateway.registerEnvironmentKey(options.gateway, accessToken, registration).pipe(
        Effect.provide(options.httpClient),
        Effect.option,
      ),
    );
    if (Option.isNone(result)) return;
    if (result.value._tag === "SignInAgain") {
      setSignInAgain(true);
      return;
    }
    // Any other answer means the session itself may register.
    setSignInAgain(false);
    if (result.value._tag === "Registered") {
      await environment.report({
        publicKey: registration.publicKey,
        outcome: { status: "registered", expiresAt: result.value.expiresAt },
      });
      return;
    }
    if (result.value._tag === "NotCurrent") {
      // Only an old key in its grace period answers this; the environment keeps its current key.
      await Effect.runPromise(
        Effect.logWarning("fwai attestation: the gateway kept this key in a non-current state", {
          status: result.value.status,
        }),
      );
      return;
    }
    await environment.report({
      publicKey: registration.publicKey,
      outcome: { status: "key-rejected" },
    });
  }
}

export interface FwaiPlanSummary {
  readonly planLabel: string | null;
  readonly fiveHourPercent: number | null;
  readonly weeklyPercent: number | null;
}

/** The signed-in account's plan and quota use, or null when signed out or unreachable. */
export async function fetchFwaiPlanSummary(
  options: FwaiGatewayClientOptions,
): Promise<FwaiPlanSummary | null> {
  const accessToken = await options.getAccessToken();
  if (accessToken === null) return null;
  const exit = await Effect.runPromiseExit(
    Effect.all(
      [
        FwaiGateway.getSubscription(options.gateway, accessToken).pipe(Effect.option),
        FwaiGateway.getUsage(options.gateway, accessToken).pipe(Effect.option),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(options.httpClient)),
  );
  if (exit._tag === "Failure") return null;
  const [subscription, usage] = exit.value;
  const plan = subscription._tag === "Some" ? subscription.value.subscription : null;
  const windows = usage._tag === "Some" ? usage.value : null;
  return {
    planLabel: plan?.active ? (plan.label ?? plan.tier ?? null) : null,
    fiveHourPercent: windows?.five_hour?.utilization ?? null,
    weeklyPercent: windows?.seven_day?.utilization ?? null,
  };
}

export interface FwaiQuotaProject {
  readonly id: string;
  readonly name: string;
  /** False when the account has no allowance here; the gateway would refuse its requests. */
  readonly usable: boolean;
  readonly fiveHourPercent: number | null;
  readonly weeklyPercent: number | null;
}

export interface FwaiOrganizationQuota {
  readonly organizationName: string;
  /** The account's own default project on the gateway. */
  readonly currentProjectId: string | null;
  readonly projects: ReadonlyArray<FwaiQuotaProject>;
}

/** The account's organization projects and their quota use; null outside an organization. */
export async function fetchFwaiOrganizationQuota(
  options: FwaiGatewayClientOptions,
): Promise<FwaiOrganizationQuota | null> {
  const accessToken = await options.getAccessToken();
  if (accessToken === null) return null;
  const exit = await Effect.runPromiseExit(
    FwaiGateway.getOrganization(options.gateway, accessToken).pipe(
      Effect.provide(options.httpClient),
    ),
  );
  if (exit._tag === "Failure" || exit.value.organization === null) return null;
  return {
    organizationName: exit.value.organization.name,
    currentProjectId: exit.value.current_project_id ?? null,
    projects: exit.value.projects
      // An owner sees every project; requests may only name the ones they are in.
      .filter((project) => project.member !== false)
      .map((project) => ({
        id: project.id,
        name: project.name,
        usable: project.has_allowance !== false,
        fiveHourPercent: project.five_hour?.used_percent ?? null,
        weeklyPercent: project.week?.used_percent ?? null,
      })),
  };
}

export function formatProjectQuota(project: {
  readonly fiveHourPercent: number | null;
  readonly weeklyPercent: number | null;
}): string | null {
  const parts = [
    project.fiveHourPercent === null ? null : `5h ${Math.round(project.fiveHourPercent)}%`,
    project.weeklyPercent === null ? null : `week ${Math.round(project.weeklyPercent)}%`,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export type FwaiRoutedDriver = "claudeAgent" | "codex";

/** Whether a thread's requests go through fwai Gateway under the environment's settings. */
export function threadRoutesThroughGateway(
  settings: {
    readonly fwaiGatewayEnabled: boolean;
    readonly fwaiGatewayClaude: boolean;
    readonly fwaiGatewayCodex: boolean;
  },
  thread: { readonly driver: string; readonly codexRoute: FwaiGatewayThreadRoute | null },
): boolean {
  if (!settings.fwaiGatewayEnabled) return false;
  if (thread.driver === "claudeAgent") return settings.fwaiGatewayClaude;
  if (thread.driver === "codex") {
    // A Codex thread keeps the provider it started on; before it starts it follows the switch.
    return thread.codexRoute === null ? settings.fwaiGatewayCodex : thread.codexRoute === "gateway";
  }
  return false;
}
