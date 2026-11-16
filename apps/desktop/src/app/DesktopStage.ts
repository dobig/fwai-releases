import { fwaiDesktopIdentity, parseFwaiStage } from "@t3tools/shared/fwaiDesktopIdentity";

declare const __T3CODE_BUILD_FWAI_STAGE__: string | undefined;

/** Names this packaged build installs under; `T3CODE_FWAI_STAGE` is baked in at build time. */
export const DESKTOP_IDENTITY = fwaiDesktopIdentity(
  parseFwaiStage(
    typeof __T3CODE_BUILD_FWAI_STAGE__ === "undefined" ? undefined : __T3CODE_BUILD_FWAI_STAGE__,
  ),
);
