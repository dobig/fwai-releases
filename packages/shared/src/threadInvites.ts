import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";

/** Invite links (#58): `<hosted app>/invite/<token>`, or `fwai://invite/<token>` in the apps. */
export const THREAD_INVITE_PATH_PREFIX = "/invite/";

const TOKEN_BYTES = 32;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

const toBase64Url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

/** The only form of a token the environment and the relay keep. */
export const hashThreadInviteToken = Effect.fn("threadInvites.hash")(function* (token: string) {
  const crypto = yield* Crypto.Crypto;
  return toHex(yield* crypto.digest("SHA-256", new TextEncoder().encode(token)));
});

export const createThreadInviteToken = Effect.fn("threadInvites.create")(function* () {
  const crypto = yield* Crypto.Crypto;
  const token = toBase64Url(yield* crypto.randomBytes(TOKEN_BYTES));
  return { token, hash: yield* hashThreadInviteToken(token) };
});

export const isThreadInviteToken = (value: string) => TOKEN_PATTERN.test(value);

export function threadInviteUrl(origin: string, token: string): string {
  return new URL(`${THREAD_INVITE_PATH_PREFIX}${token}`, origin).toString();
}

/** The token in an app path such as `/invite/<token>`, or null. */
export function threadInviteTokenFromPath(pathname: string): string | null {
  if (!pathname.startsWith(THREAD_INVITE_PATH_PREFIX)) return null;
  const token = pathname.slice(THREAD_INVITE_PATH_PREFIX.length).replace(/\/$/, "");
  return isThreadInviteToken(token) ? token : null;
}
