// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { loadRepoEnv } from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_FWAI_GATEWAY_URL=https://gateway.root.test\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_FWAI_GATEWAY_URL=https://gateway.local.test\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot })).toMatchObject({
      T3CODE_RELAY_URL: "https://local.example.test",
      T3CODE_FWAI_GATEWAY_URL: "https://gateway.local.test",
    });
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_FWAI_GATEWAY_URL: "https://gateway.ci.test",
          T3CODE_FWAI_CLIENT_ID: "fwai_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_FWAI_GATEWAY_URL: "https://gateway.ci.test",
      VITE_T3CODE_FWAI_GATEWAY_URL: "https://gateway.ci.test",
      EXPO_PUBLIC_T3CODE_FWAI_GATEWAY_URL: "https://gateway.ci.test",
      T3CODE_FWAI_CLIENT_ID: "fwai_ci",
      VITE_T3CODE_FWAI_CLIENT_ID: "fwai_ci",
      EXPO_PUBLIC_T3CODE_FWAI_CLIENT_ID: "fwai_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });

  it("defaults the fwai gateway and client id", () => {
    expect(loadRepoEnv({ baseEnv: {}, repoRoot: makeTemporaryDirectory() })).toMatchObject({
      T3CODE_FWAI_GATEWAY_URL: "https://api.fwai.space",
      VITE_T3CODE_FWAI_GATEWAY_URL: "https://api.fwai.space",
      T3CODE_FWAI_CLIENT_ID: "fwai",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
