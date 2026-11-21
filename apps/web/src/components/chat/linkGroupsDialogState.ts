import type { EnvironmentId, LinkChainId, LinkGroupId, ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  type LinkCandidate,
  type LinkCommandInput,
  NO_LINK_COMMAND_INPUT,
} from "@t3tools/client-runtime/link-groups";

export interface LinkThreadsDialogTarget {
  readonly threadRef: ScopedThreadRef;
  /** Adds to this group instead of creating one; this thread joins it if it is not a member. */
  readonly linkId: LinkGroupId | null;
  /** A thread checked when the picker opens. */
  readonly preselect: LinkCandidate | null;
  /** What `/link` was given, so nothing typed is lost. */
  readonly command: LinkCommandInput;
}

/**
 * Menus and the command palette close as their command runs, so the root renders the link
 * dialogs once and these atoms say which one is open.
 */
export const linkThreadsDialogAtom = Atom.make<LinkThreadsDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("link-groups:dialog-thread"),
);

/** `/link` when the two threads' groups are several: which group they meet in. */
export interface LinkGroupChoiceDialogTarget {
  readonly threadRef: ScopedThreadRef;
  readonly candidate: LinkCandidate;
  readonly command: LinkCommandInput;
}

export const linkGroupChoiceDialogAtom = Atom.make<LinkGroupChoiceDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("link-groups:dialog-group-choice"),
);

export function openLinkGroupChoiceDialog(target: LinkGroupChoiceDialogTarget): void {
  appAtomRegistry.set(linkGroupChoiceDialogAtom, target);
}

export interface LinkChainDialogTarget {
  readonly environmentId: EnvironmentId;
  readonly chainId: LinkChainId;
}

export const linkChainDialogAtom = Atom.make<LinkChainDialogTarget | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("link-groups:dialog-chain"),
);

export function openLinkThreadsDialog(
  threadRef: ScopedThreadRef,
  options: {
    readonly linkId?: LinkGroupId | null;
    readonly preselect?: LinkCandidate;
    readonly command?: LinkCommandInput;
  } = {},
): void {
  appAtomRegistry.set(linkThreadsDialogAtom, {
    threadRef,
    linkId: options.linkId ?? null,
    preselect: options.preselect ?? null,
    command: options.command ?? NO_LINK_COMMAND_INPUT,
  });
}

export function openLinkChainDialog(target: LinkChainDialogTarget): void {
  appAtomRegistry.set(linkChainDialogAtom, target);
}
