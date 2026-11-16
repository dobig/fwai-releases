import { UNKNOWN_COLLEAGUE_NAME } from "@t3tools/client-runtime/sharing/colleagues";
import type { RelayOrgShareRequest } from "@t3tools/contracts/relay";
import type { AnyRouter } from "@tanstack/react-router";
import type { AtomRegistry } from "effect/reactivity";
import { UsersIcon } from "lucide-react";

import { getFwaiOrganizationDirectory } from "../../fwaiAccount/session";
import { getClientSettings } from "../../hooks/useSettings";
import { sharedThreads } from "../../state/sharing";
import { searchableSetting } from "../settings/settingsSearch";
import { toastManager } from "../ui/toast";

const describe = (name: string, request: RelayOrgShareRequest) =>
  `${name} wants to share "${request.title || "Untitled thread"}" with the whole organization`;

/**
 * An in-app toast for each whole-organization share request that reaches an org owner while the
 * app is open. The runtime announces a request once; requests already waiting only count.
 */
export function startOrgShareRequestAlerts(
  registry: AtomRegistry.AtomRegistry,
  router: AnyRouter,
): () => void {
  const pendingNames = new Set<() => void>();
  const target = searchableSetting("org-share-requests").id;

  const present = (request: RelayOrgShareRequest) => {
    const usernames = getFwaiOrganizationDirectory()?.usernames;
    const name = usernames?.get(request.ownerSub);
    const toastId = toastManager.add({
      type: "info",
      title: "Share request",
      description: describe(name ?? UNKNOWN_COLLEAGUE_NAME, request),
      data: {
        hideCopyButton: true,
        leadingIcon: <UsersIcon aria-hidden className="size-4 text-info-foreground" />,
      },
      actionProps: {
        children: "Review",
        onClick: () => {
          toastManager.close(toastId);
          void router.navigate({
            to: "/settings/sharing",
            hash: target,
            hashScrollIntoView: false,
            state: { settingsTargetHighlight: true },
          });
        },
      },
    });
    if (usernames === undefined || name !== undefined) return;
    // Names usually resolve within a lookup; the toast picks it up when it does.
    const unsubscribe = usernames.subscribe(() => {
      const resolved = usernames.get(request.ownerSub);
      if (resolved === undefined) return;
      unsubscribe();
      pendingNames.delete(unsubscribe);
      toastManager.update(toastId, {
        description: describe(resolved ?? UNKNOWN_COLLEAGUE_NAME, request),
      });
    });
    pendingNames.add(unsubscribe);
    usernames.request([request.ownerSub]);
  };

  let previous: unknown = null;
  const unsubscribe = registry.subscribe(
    sharedThreads.orgShareRequestsValueAtom,
    (state) => {
      if (state === previous) return;
      previous = state;
      if (!getClientSettings().inAppNotificationsEnabled) return;
      if (router.state.location.pathname === "/settings/sharing") return;
      for (const request of state.arrived) present(request);
    },
    { immediate: true },
  );
  return () => {
    unsubscribe();
    for (const stop of pendingNames) stop();
    pendingNames.clear();
  };
}
