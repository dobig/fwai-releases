import { isSharedEnvironmentEntry } from "@t3tools/client-runtime/connection";
import { createSharedThreadAtoms } from "@t3tools/client-runtime/state/sharing";
import {
  findSharedThread,
  threadCapabilities,
} from "@t3tools/client-runtime/sharing/shared-threads";
import type { EnvironmentId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { serverEnvironment } from "./server";
import { environmentShell } from "./shell";

export const sharedThreads: ReturnType<typeof createSharedThreadAtoms> = createSharedThreadAtoms(
  connectionAtomRuntime,
  {
    removedThreads: (get, environmentId) =>
      get(isSharedEnvironmentAtom(environmentId))
        ? get(environmentShell.stateValueAtom(environmentId)).removedAt
        : undefined,
  },
);

/** Someone else's environment, opened from "Shared with me" or "Team". */
export const isSharedEnvironmentAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const entry = get(environmentCatalog.catalogValueAtom).entries.get(environmentId);
    return entry !== undefined && isSharedEnvironmentEntry(entry);
  }).pipe(Atom.withLabel(`shared-environment:${environmentId}`)),
);

export function readIsSharedEnvironment(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(isSharedEnvironmentAtom(environmentId));
}

/** What the UI may offer on a thread; a shared environment refuses all but reading and messages. */
export const threadCapabilitiesAtom = Atom.family((key: string) => {
  const [environmentId, threadId] = JSON.parse(key) as [EnvironmentId, string];
  return Atom.make((get) => {
    const shared = findSharedThread(
      get(sharedThreads.stateValueAtom).threads,
      environmentId,
      threadId,
    );
    return threadCapabilities({
      sharedEnvironment: get(isSharedEnvironmentAtom(environmentId)),
      role: shared?.role ?? null,
      requireApproval: shared?.requireApproval,
    });
  }).pipe(Atom.withLabel(`thread-capabilities:${key}`));
});

export const threadCapabilitiesKey = (ref: ScopedThreadRef) =>
  JSON.stringify([ref.environmentId, ref.threadId]);

/** "Share" needs `access:write` on the owner's own environment. */
export const canShareWithOrganizationAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      !get(isSharedEnvironmentAtom(environmentId)) &&
      get(serverEnvironment.grantThreadShare.permissionAtom(environmentId)),
  ).pipe(Atom.withLabel(`thread-share:available:${environmentId}`)),
);

/** The gateway account that owns a shared environment, from the relay's shared-thread list. */
export const sharedEnvironmentOwnerAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    if (!get(isSharedEnvironmentAtom(environmentId))) return null;
    return (
      get(sharedThreads.stateValueAtom).threads.find(
        (thread) => thread.environmentId === environmentId,
      )?.ownerSub ?? null
    );
  }).pipe(Atom.withLabel(`shared-environment-owner:${environmentId}`)),
);

export function readCanShareWithOrganization(environmentId: EnvironmentId): boolean {
  return appAtomRegistry.get(canShareWithOrganizationAtom(environmentId));
}
