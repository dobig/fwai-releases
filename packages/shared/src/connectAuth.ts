export const DEFAULT_HOSTED_APP_URL = "https://chat.fwaii.com";
// fwai: hosted web origins a provider sign-in may return to (prod, staging).
export const HOSTED_APP_ORIGINS: ReadonlyArray<string> = [
  DEFAULT_HOSTED_APP_URL,
  "https://chat-staging.fwaii.com",
];
