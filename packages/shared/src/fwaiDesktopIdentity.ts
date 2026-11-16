/**
 * OS-visible names of a packaged fwai desktop app, per deployment stage. A staging build must
 * install beside production without sharing its bundle, deep links, data or CLI command.
 * Development builds keep their own `.dev` names and do not use this.
 */
export type FwaiStage = "prod" | "staging";

export interface FwaiDesktopIdentity {
  readonly stage: FwaiStage;
  /** Bundle id, AppUserModelId and keychain access group suffix. */
  readonly appId: string;
  /** Packaged product name. Undefined: prod's name from apps/desktop/package.json (or Nightly). */
  readonly productName: string | undefined;
  /** Shown after the base name, e.g. `fwai (Staging)`. Undefined: prod's Beta/Nightly label. */
  readonly stageLabel: string | undefined;
  readonly scheme: string;
  /** Schemes the installer registers with the OS. */
  readonly packagedSchemes: readonly string[];
  /** Directory under the home directory holding fwai's data (`~/.fwai`). */
  readonly homeDirName: string;
  /** Electron profile directory under the OS app-data directory. */
  readonly userDataDirName: string;
  /** Name of the `fwai` CLI command, the Linux executable and WM class. */
  readonly commandName: string;
  readonly linuxDesktopEntryName: string;
}

const PROD: FwaiDesktopIdentity = {
  stage: "prod",
  appId: "com.fwaii.code",
  productName: undefined,
  stageLabel: undefined,
  scheme: "fwai",
  packagedSchemes: ["fwai", "fwai-dev"],
  homeDirName: ".fwai",
  userDataDirName: "fwai",
  commandName: "fwai",
  linuxDesktopEntryName: "com.fwaii.Code.desktop",
};

const STAGING: FwaiDesktopIdentity = {
  stage: "staging",
  appId: "com.fwaii.code.staging",
  productName: "fwai Staging",
  stageLabel: "Staging",
  scheme: "fwai-staging",
  packagedSchemes: ["fwai-staging"],
  homeDirName: ".fwai-staging",
  userDataDirName: "fwai-staging",
  commandName: "fwai-staging",
  linuxDesktopEntryName: "com.fwaii.Code.Staging.desktop",
};

/** Every packaged desktop scheme, for allow-lists that must accept any stage's renderer. */
export const FWAI_DESKTOP_SCHEMES = [PROD.scheme, STAGING.scheme] as const;

/** Reads `T3CODE_FWAI_STAGE`; unset or empty means prod, so builds without a stage are unchanged. */
export function parseFwaiStage(value: string | undefined): FwaiStage {
  const stage = value?.trim() ?? "";
  if (stage === "" || stage === "prod") return "prod";
  if (stage === "staging") return "staging";
  throw new Error(`T3CODE_FWAI_STAGE must be "prod" or "staging", got "${stage}".`);
}

export function fwaiDesktopIdentity(stage: FwaiStage): FwaiDesktopIdentity {
  return stage === "staging" ? STAGING : PROD;
}
