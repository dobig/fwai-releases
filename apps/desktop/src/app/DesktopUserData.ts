import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import { DESKTOP_IDENTITY } from "./DesktopStage.ts";

/**
 * fwai's own Electron profile. Upstream migrates T3 Code's older profiles here; fwai has no
 * earlier versions and must never take over T3 Code's profile, so there is no migration.
 */
export const resolveUserDataPath = Effect.fn("desktop.userData.resolveUserDataPath")(
  function* (input: { readonly appDataDirectory: string; readonly isDevelopment: boolean }) {
    const path = yield* Path.Path;
    return path.join(
      input.appDataDirectory,
      input.isDevelopment ? "fwai-dev" : DESKTOP_IDENTITY.userDataDirName,
    );
  },
);
