import {
  createFwaiAccountSession,
  type FwaiAccountSession,
  type FwaiAccountStorage,
} from "@t3tools/client-runtime/account";
import {
  createFwaiOrganizationDirectory,
  type FwaiOrganizationDirectory,
} from "@t3tools/client-runtime/sharing/organization-directory";
import type { DesktopBridge } from "@t3tools/contracts";
import * as FwaiGateway from "@t3tools/shared/fwaiGateway";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient } from "effect/http";

import { APP_VERSION } from "../branding";
import { hasCloudPublicConfig, resolveCloudPublicConfig } from "../cloud/publicConfig";
import { clientPresentationMetadata } from "../connection/clientMetadata";
import { makeDesktopGatewayFetch } from "./desktopGatewayFetch";

const BROWSER_SESSION_STORAGE_KEY = "fwai:account-session";

function selectFwaiAccountStorage(
  bridge: DesktopBridge | undefined,
  browserStorage: Storage,
): FwaiAccountStorage {
  const { getFwaiAccountSession, setFwaiAccountSession, clearFwaiAccountSession } = bridge ?? {};
  if (getFwaiAccountSession && setFwaiAccountSession && clearFwaiAccountSession) {
    return {
      load: () => getFwaiAccountSession(),
      save: (value) => setFwaiAccountSession(value),
      clear: () => clearFwaiAccountSession(),
    };
  }
  return {
    load: async () => browserStorage.getItem(BROWSER_SESSION_STORAGE_KEY),
    save: async (value) => browserStorage.setItem(BROWSER_SESSION_STORAGE_KEY, value),
    clear: async () => browserStorage.removeItem(BROWSER_SESSION_STORAGE_KEY),
  };
}

function gatewayHttpClient(bridge: DesktopBridge | undefined) {
  if (!bridge?.fwaiGatewayFetch) return FetchHttpClient.layer;
  return FetchHttpClient.layer.pipe(
    Layer.provide(
      Layer.succeed(FetchHttpClient.Fetch, makeDesktopGatewayFetch(bridge.fwaiGatewayFetch)),
    ),
  );
}

function deviceInfo(bridge: DesktopBridge | undefined) {
  const metadata = clientPresentationMetadata({
    appVersion: APP_VERSION,
    hosted: true,
    identity: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      maxTouchPoints: navigator.maxTouchPoints,
    },
    desktopBridge: bridge,
  });
  return bridge
    ? {
        deviceName: `fwai desktop (${metadata.os})`,
        platform: "desktop",
        appVersion: APP_VERSION,
      }
    : {
        deviceName: `fwai web (${metadata.browser ?? "browser"} on ${metadata.os})`,
        platform: "web",
        appVersion: APP_VERSION,
      };
}

let session: FwaiAccountSession | null = null;

/** The app's account session, or null when this build or origin has no account features. */
export function getFwaiAccountSession(): FwaiAccountSession | null {
  if (session) return session;
  if (!hasCloudPublicConfig()) return null;
  const config = resolveCloudPublicConfig();
  if (!config.gatewayUrl) return null;
  const bridge = window.desktopBridge;
  session = createFwaiAccountSession({
    gateway: { gatewayUrl: config.gatewayUrl, clientId: config.gatewayClientId },
    device: deviceInfo(bridge),
    storage: selectFwaiAccountStorage(bridge, window.localStorage),
    httpClient: gatewayHttpClient(bridge),
    onBackgroundError: (label, error) => console.warn(`fwai account: ${label} failed.`, error),
  });
  return session;
}

let directory: { readonly userId: string; readonly directory: FwaiOrganizationDirectory } | null =
  null;

/**
 * The signed-in account's organization directory (colleagues, projects, usernames). A new account
 * gets a new directory, so usernames never leak across accounts. Null without an account.
 */
export function getFwaiOrganizationDirectory(): FwaiOrganizationDirectory | null {
  const account = getFwaiAccountSession();
  if (account === null) return null;
  const state = account.getState();
  if (state.status !== "signedIn") return null;
  if (directory?.userId === state.user.id) return directory.directory;
  const config = resolveCloudPublicConfig();
  if (!config.gatewayUrl) return null;
  directory = {
    userId: state.user.id,
    directory: createFwaiOrganizationDirectory({
      gateway: { gatewayUrl: config.gatewayUrl, clientId: config.gatewayClientId },
      httpClient: gatewayHttpClient(window.desktopBridge),
      getAccessToken: () => account.getAccessToken(),
    }),
  };
  return directory.directory;
}

/**
 * Approves an environment's fwai Gateway sign-in code with this app's own account, so turning on
 * gateway routing never asks the user to sign in again. Rejects when no account is signed in.
 */
export async function approveFwaiDeviceCode(userCode: string): Promise<void> {
  const account = getFwaiAccountSession();
  const accessToken = account === null ? null : await account.getAccessToken();
  if (accessToken === null) throw new Error("Sign in to fwai first.");
  const config = resolveCloudPublicConfig();
  if (!config.gatewayUrl) throw new Error("This build has no fwai gateway.");
  await Effect.runPromise(
    FwaiGateway.approveDeviceCode(
      { gatewayUrl: config.gatewayUrl, clientId: config.gatewayClientId },
      accessToken,
      userCode,
    ).pipe(Effect.provide(gatewayHttpClient(window.desktopBridge))),
  );
}

export interface FwaiPlanSummary {
  readonly planLabel: string | null;
  readonly fiveHourPercent: number | null;
  readonly weeklyPercent: number | null;
}

/** The signed-in account's plan and quota use, or null when signed out or unreachable. */
export async function fetchFwaiPlanSummary(): Promise<FwaiPlanSummary | null> {
  const account = getFwaiAccountSession();
  const accessToken = account === null ? null : await account.getAccessToken();
  const config = resolveCloudPublicConfig();
  if (accessToken === null || !config.gatewayUrl) return null;
  const gateway = { gatewayUrl: config.gatewayUrl, clientId: config.gatewayClientId };
  const exit = await Effect.runPromiseExit(
    Effect.all(
      [
        FwaiGateway.getSubscription(gateway, accessToken).pipe(Effect.option),
        FwaiGateway.getUsage(gateway, accessToken).pipe(Effect.option),
      ],
      { concurrency: 2 },
    ).pipe(Effect.provide(gatewayHttpClient(window.desktopBridge))),
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
export async function fetchFwaiOrganizationQuota(): Promise<FwaiOrganizationQuota | null> {
  const account = getFwaiAccountSession();
  const accessToken = account === null ? null : await account.getAccessToken();
  const config = resolveCloudPublicConfig();
  if (accessToken === null || !config.gatewayUrl) return null;
  const exit = await Effect.runPromiseExit(
    FwaiGateway.getOrganization(
      { gatewayUrl: config.gatewayUrl, clientId: config.gatewayClientId },
      accessToken,
    ).pipe(Effect.provide(gatewayHttpClient(window.desktopBridge))),
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
