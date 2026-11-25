// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

/** Node 20.12+ cannot spawn Windows launcher scripts without a shell; the SDK cannot use these as executables. */
const WINDOWS_SHIM_EXTENSIONS: ReadonlySet<string> = new Set([".cmd", ".bat", ".ps1"]);

export const isWindowsClaudeLauncherShimPath = (filePath: string): boolean =>
  WINDOWS_SHIM_EXTENSIONS.has(NodePath.win32.extname(filePath).toLowerCase());

/** New packages provide bin/claude.exe; older packages need a JavaScript runtime for cli.js. */
const NPM_PACKAGE_ENTRY_CANDIDATES = [
  ["node_modules", "@anthropic-ai", "claude-code", "bin", "claude.exe"],
  ["node_modules", "@anthropic-ai", "claude-code", "cli.js"],
] as const;

export type ExecutableFileCheck = (filePath: string) => boolean;
export type LauncherShimRead = (filePath: string) => string | undefined;

function isExistingFile(filePath: string): boolean {
  try {
    return NodeFS.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function readTextFile(filePath: string): string | undefined {
  try {
    return NodeFS.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

export const ClaudeExecutableFileCheck = Context.Reference<ExecutableFileCheck>(
  "server/provider/Drivers/ClaudeExecutableFileCheck",
  {
    defaultValue: () => isExistingFile,
  },
);

export const ClaudeLauncherShimRead = Context.Reference<LauncherShimRead>(
  "server/provider/Drivers/ClaudeLauncherShimRead",
  {
    defaultValue: () => readTextFile,
  },
);

// npm writes `"%dp0%\..."`, pnpm and yarn `"%~dp0\..."`, and their .ps1 shims `"$basedir/..."`.
const SHIM_TARGET_PATTERN = /"(?:%~?dp0%?|\$basedir)[\\/]([^"]+)"/gi;

/** The script or binary a package-manager shim launches, skipping the node.exe it may run it with. */
const shimTargets = (shimPath: string, content: string): ReadonlyArray<string> => {
  const shimDirectory = NodePath.win32.dirname(shimPath);
  return [...content.matchAll(SHIM_TARGET_PATTERN)].flatMap(([, relative]) => {
    const target = NodePath.win32.join(shimDirectory, relative!);
    const extension = NodePath.win32.extname(target).toLowerCase();
    const isEntry =
      (extension === ".exe" || extension === ".js") &&
      NodePath.win32.basename(target).toLowerCase() !== "node.exe";
    return isEntry ? [target] : [];
  });
};

const resolveOnWindows = Effect.fn("resolveClaudeSdkExecutablePath.windows")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
) {
  const resolveExecutable = yield* SpawnExecutableResolution;
  const isFile = yield* ClaudeExecutableFileCheck;
  const readShim = yield* ClaudeLauncherShimRead;
  const resolved = resolveExecutable(binaryPath, "win32", environment) ?? binaryPath;
  if (!isWindowsClaudeLauncherShimPath(resolved)) {
    return { executablePath: resolved };
  }

  const shimContent = readShim(resolved);
  const shimDirectory = NodePath.win32.dirname(resolved);
  const candidates = [
    ...(shimContent === undefined ? [] : shimTargets(resolved, shimContent)),
    ...NPM_PACKAGE_ENTRY_CANDIDATES.map((segments) =>
      NodePath.win32.join(shimDirectory, ...segments),
    ),
  ];
  const entry = candidates.find(isFile);
  return entry === undefined
    ? { executablePath: binaryPath, unlaunchableShim: resolved }
    : { executablePath: entry };
});

/** On Windows the SDK skips shell and PATH/PATHEXT lookup: bare names and .cmd shims fail. */
export const resolveClaudeSdkExecutablePath = Effect.fn("resolveClaudeSdkExecutablePath")(
  function* (binaryPath: string, environment: NodeJS.ProcessEnv): Effect.fn.Return<string> {
    if ((yield* HostProcess.Platform) !== "win32") {
      return binaryPath;
    }
    const resolution = yield* resolveOnWindows(binaryPath, environment);
    if (resolution.unlaunchableShim !== undefined) {
      yield* Effect.logWarning(
        "Claude launcher shim resolved but no package entry was found for it; the Claude Agent SDK cannot spawn launcher scripts directly.",
        { binaryPath, resolvedShimPath: resolution.unlaunchableShim },
      );
    }
    return resolution.executablePath;
  },
);

/** The Windows launcher script `binaryPath` resolves to when no spawnable entry was found behind it. */
export const findUnlaunchableClaudeShim = Effect.fn("findUnlaunchableClaudeShim")(function* (
  binaryPath: string,
  environment: NodeJS.ProcessEnv,
): Effect.fn.Return<string | undefined> {
  if ((yield* HostProcess.Platform) !== "win32") {
    return undefined;
  }
  return (yield* resolveOnWindows(binaryPath, environment)).unlaunchableShim;
});
