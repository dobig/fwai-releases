import type { DesktopAppBranding } from "@t3tools/contracts";
import { formatAppDisplayName } from "./branding.logic";

function readInjectedDesktopAppBranding(): DesktopAppBranding | null {
  if (typeof window === "undefined") {
    return null;
  }

  return window.desktopBridge?.getAppBranding?.() ?? null;
}

const injectedDesktopAppBranding = readInjectedDesktopAppBranding();
const hostedAppChannel = import.meta.env.VITE_HOSTED_APP_CHANNEL?.trim().toLowerCase();

export const HOSTED_APP_CHANNEL =
  hostedAppChannel === "latest" || hostedAppChannel === "nightly" ? hostedAppChannel : null;
export const HOSTED_APP_CHANNEL_LABEL =
  HOSTED_APP_CHANNEL === "nightly" ? "Nightly" : HOSTED_APP_CHANNEL === "latest" ? "Latest" : null;
export const APP_BASE_NAME = injectedDesktopAppBranding?.baseName ?? "fwai";
/** Null for the released app, which is plain `fwai`. */
export const APP_STAGE_LABEL: string | null = injectedDesktopAppBranding
  ? injectedDesktopAppBranding.stageLabel
  : (HOSTED_APP_CHANNEL_LABEL ?? (import.meta.env.DEV ? "Dev" : null));
export const APP_DISPLAY_NAME =
  injectedDesktopAppBranding?.displayName ??
  formatAppDisplayName({ baseName: APP_BASE_NAME, stageLabel: APP_STAGE_LABEL });
export const APP_VERSION = import.meta.env.APP_VERSION || "0.0.0";
export const DESKTOP_DOWNLOAD_URL = "https://github.com/dobig/fwai-releases/releases";
/** fwai's mobile app is not in the stores yet; a null store is left out of Settings. */
export const MOBILE_APP_STORE_URLS: {
  readonly appStore: string | null;
  readonly googlePlay: string | null;
} = { appStore: null, googlePlay: null };
export const HAS_MOBILE_APP_STORE_LINKS =
  MOBILE_APP_STORE_URLS.appStore !== null || MOBILE_APP_STORE_URLS.googlePlay !== null;
