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
import * as SharedFwaiGateway from "@t3tools/client-runtime/fwai-gateway";
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

function gatewayClientOptions(): SharedFwaiGateway.FwaiGatewayClientOptions | null {
  const config = resolveCloudPublicConfig();
  if (!config.gatewayUrl) return null;
  return {
    gateway: { gatewayUrl: config.gatewayUrl, clientId: config.gatewayClientId },
    getAccessToken: async () => (await getFwaiAccountSession()?.getAccessToken()) ?? null,
    httpClient: gatewayHttpClient(window.desktopBridge),
  };
}

export type {
  FwaiOrganizationQuota,
  FwaiPlanSummary,
  FwaiQuotaProject,
} from "@t3tools/client-runtime/fwai-gateway";

/** Approves an environment's fwai Gateway sign-in with this app's account (no second sign-in). */
export async function approveFwaiDeviceCode(userCode: string): Promise<void> {
  const options = gatewayClientOptions();
  if (options === null) throw new Error("This build has no fwai gateway.");
  await SharedFwaiGateway.approveFwaiDeviceCode(options, userCode);
}

export async function fetchFwaiPlanSummary() {
  const options = gatewayClientOptions();
  return options === null ? null : SharedFwaiGateway.fetchFwaiPlanSummary(options);
}

export async function fetchFwaiOrganizationQuota() {
  const options = gatewayClientOptions();
  return options === null ? null : SharedFwaiGateway.fetchFwaiOrganizationQuota(options);
}
