import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { resolveUserDataPath } from "./DesktopUserData.ts";

it.effect.each([
  { isDevelopment: false, expected: "fwai" },
  { isDevelopment: true, expected: "fwai-dev" },
])("uses the $expected profile and never T3 Code's", ({ isDevelopment, expected }) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "fwai-profile-" });
    for (const name of ["t3code", "t3code-v2", "t3code-dev", "T3 Code (Alpha)", "T3 Code (Dev)"]) {
      yield* fs.makeDirectory(path.join(directory, name), { recursive: true });
      yield* fs.writeFileString(path.join(directory, name, "Local State"), "T3 Code state");
    }
    const userData = yield* resolveUserDataPath({ appDataDirectory: directory, isDevelopment });
    assert.equal(userData, path.join(directory, expected));
    assert.isFalse(yield* fs.exists(path.join(directory, expected)));
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
