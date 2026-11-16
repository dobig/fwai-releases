import { ORCHESTRATION_PROTOCOL_HEADER } from "@t3tools/contracts";
import { FWAI_DESKTOP_SCHEMES } from "@t3tools/shared/fwaiDesktopIdentity";

export const browserApiCorsAllowedMethods = ["GET", "POST", "OPTIONS"] as const;
export const browserApiCorsAllowedHeaders = [
  "authorization",
  "b3",
  "traceparent",
  "content-type",
  "dpop",
  ORCHESTRATION_PROTOCOL_HEADER,
] as const;

export const DESKTOP_RENDERER_ORIGINS = [
  ...FWAI_DESKTOP_SCHEMES.map((scheme) => `${scheme}://app`),
  "fwai-dev://app",
];
