import { describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { SpawnExecutableResolution } from "@t3tools/shared/shell";
import * as Effect from "effect/Effect";

import {
  ClaudeExecutableFileCheck,
  ClaudeLauncherShimRead,
  findUnlaunchableClaudeShim,
  resolveClaudeSdkExecutablePath,
} from "./ClaudeExecutable.ts";

const NPM_DIR = "C:\\Users\\dev\\AppData\\Roaming\\npm";
const NPM_SHIM = `${NPM_DIR}\\claude.cmd`;
const NPM_PACKAGE_EXE = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
const NPM_PACKAGE_CLI = `${NPM_DIR}\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;

function withWindowsResolution(input: {
  readonly resolvedCommand: string | undefined;
  readonly existingFiles?: ReadonlyArray<string>;
  readonly shims?: Readonly<Record<string, string>>;
}) {
  const existing = new Set(input.existingFiles ?? []);
  const shims = input.shims ?? {};
  return <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.provideService(HostProcess.Platform, "win32"),
      Effect.provideService(SpawnExecutableResolution, () => input.resolvedCommand),
      Effect.provideService(ClaudeExecutableFileCheck, (filePath) => existing.has(filePath)),
      Effect.provideService(ClaudeLauncherShimRead, (filePath) => shims[filePath]),
    );
}

describe("resolveClaudeSdkExecutablePath", () => {
  it.effect("follows an npm launcher shim to the packaged native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_EXE, NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("follows .bat and .ps1 launcher shims the same way", () =>
    Effect.gen(function* () {
      for (const shim of [`${NPM_DIR}\\claude.bat`, `${NPM_DIR}\\claude.ps1`]) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [NPM_PACKAGE_EXE],
            }),
          ),
        ).toBe(NPM_PACKAGE_EXE);
      }
    }),
  );

  it.effect("normalizes mixed-case shim extensions before matching", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: `${NPM_DIR}\\claude.CMD`,
            existingFiles: [NPM_PACKAGE_EXE],
          }),
        ),
      ).toBe(NPM_PACKAGE_EXE);
    }),
  );

  it.effect("falls back to cli.js when the package ships no native binary", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: NPM_SHIM,
            existingFiles: [NPM_PACKAGE_CLI],
          }),
        ),
      ).toBe(NPM_PACKAGE_CLI);
    }),
  );

  it.effect("returns the configured path when a shim has no known package entry", () =>
    Effect.gen(function* () {
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM }),
        ),
      ).toBe("claude");
    }),
  );

  // A local `npm install` puts the shim in node_modules\.bin, one level below the package.
  it.effect("follows a local node_modules/.bin shim to the binary it launches", () =>
    Effect.gen(function* () {
      const root = "H:\\workplace\\claude\\node_modules";
      const shim = `${root}\\.bin\\claude.CMD`;
      const exe = `${root}\\@anthropic-ai\\claude-code\\bin\\claude.exe`;
      expect(
        yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
          withWindowsResolution({
            resolvedCommand: shim,
            existingFiles: [exe],
            shims: {
              [shim]: [
                "@ECHO off",
                "GOTO start",
                ":find_dp0",
                "SET dp0=%~dp0",
                "EXIT /b",
                ":start",
                "SETLOCAL",
                "CALL :find_dp0",
                '"%dp0%\\..\\@anthropic-ai\\claude-code\\bin\\claude.exe"   %*',
              ].join("\r\n"),
            },
          }),
        ),
      ).toBe(exe);
    }),
  );

  it.effect("follows pnpm and PowerShell shims past the node.exe they run", () =>
    Effect.gen(function* () {
      const pnpmDir = "C:\\Users\\dev\\AppData\\Local\\pnpm";
      const cli = `${pnpmDir}\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js`;
      const shims = {
        [`${pnpmDir}\\claude.CMD`]: [
          '@IF EXIST "%~dp0\\node.exe" (',
          '  "%~dp0\\node.exe"  "%~dp0\\global\\5\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
          ")",
        ].join("\r\n"),
        [`${pnpmDir}\\claude.ps1`]:
          '& "$basedir/node$exe"  "$basedir/global/5/node_modules/@anthropic-ai/claude-code/cli.js" $args',
      };
      for (const shim of Object.keys(shims)) {
        expect(
          yield* resolveClaudeSdkExecutablePath("claude", {}).pipe(
            withWindowsResolution({
              resolvedCommand: shim,
              existingFiles: [`${pnpmDir}\\node.exe`, cli],
              shims,
            }),
          ),
        ).toBe(cli);
      }
    }),
  );

  it.effect("names the shim it could not see through", () =>
    Effect.gen(function* () {
      expect(
        yield* findUnlaunchableClaudeShim("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM, shims: { [NPM_SHIM]: "@ECHO off" } }),
        ),
      ).toBe(NPM_SHIM);
      expect(
        yield* findUnlaunchableClaudeShim("claude", {}).pipe(
          withWindowsResolution({ resolvedCommand: NPM_SHIM, existingFiles: [NPM_PACKAGE_EXE] }),
        ),
      ).toBeUndefined();
    }),
  );
});
