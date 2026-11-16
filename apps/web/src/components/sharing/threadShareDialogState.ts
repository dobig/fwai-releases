import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";

/** Which thread has the share dialog open; the thread menu and palette close before it renders. */
export const threadShareDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("thread-share:dialog-thread"),
);

export function openThreadShareDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(threadShareDialogThreadAtom, threadRef);
}
