import {
  colleagueAvatarColor,
  colleagueInitial,
  resolveMessageAuthorId,
  UNKNOWN_COLLEAGUE_NAME,
} from "@t3tools/client-runtime/sharing/colleagues";
import type { OrganizationLoadState } from "@t3tools/client-runtime/sharing/organization-directory";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import { useSyncExternalStore } from "react";

import { getFwaiOrganizationDirectory } from "~/fwaiAccount/session";
import { useFwaiAccount } from "~/fwaiAccount/useFwaiAccount";
import { cn } from "~/lib/utils";
import { sharedEnvironmentOwnerAtom } from "~/state/sharing";

const subscribeToNothing = () => () => undefined;
const noVersion = () => 0;
const NO_ORGANIZATION: OrganizationLoadState = { status: "none" };
const readNoOrganization = () => NO_ORGANIZATION;

/** The signed-in account's organization directory; re-reads when the account changes. */
export function useOrganizationDirectory() {
  const account = useFwaiAccount();
  return account.status === "signedIn" ? getFwaiOrganizationDirectory() : null;
}

export function useSignedInUserId(): string | null {
  const account = useFwaiAccount();
  return account.status === "signedIn" ? account.user.id : null;
}

/**
 * The signed-in account's organization, read once and shared (team badge, team panel, composer).
 * Reading it starts the load; `none` without an account.
 */
export function useOrganizationState(): OrganizationLoadState {
  const store = useOrganizationDirectory()?.organization ?? null;
  const state = useSyncExternalStore(
    store?.subscribe ?? subscribeToNothing,
    store?.get ?? readNoOrganization,
  );
  // Idempotent: concurrent and repeated loads share one read.
  if (store !== null && state.status === "loading") void store.load();
  return state;
}

/** The signed-in account is in an organization: the app shows its team edition. */
export function useIsTeamEdition(): boolean {
  return useOrganizationState().status === "ready";
}

/** The colleague who wrote a user message, or null when the viewer wrote it. */
export function useMessageColleagueId(
  environmentId: EnvironmentId,
  authorAccountId: string | undefined,
): string | null {
  const signedInUserId = useSignedInUserId();
  const sharedOwnerId = useAtomValue(sharedEnvironmentOwnerAtom(environmentId));
  return resolveMessageAuthorId({ authorAccountId, sharedOwnerId, signedInUserId });
}

/**
 * A colleague's username from the members directory, "A colleague" until it resolves or when the
 * gateway does not know them. Lookups are batched and cached per account.
 */
export function useColleagueName(userId: string | null): string {
  const cache = useOrganizationDirectory()?.usernames ?? null;
  useSyncExternalStore(cache?.subscribe ?? subscribeToNothing, cache?.getVersion ?? noVersion);
  if (cache === null || userId === null) return UNKNOWN_COLLEAGUE_NAME;
  const name = cache.get(userId);
  // A cache read: the lookup is deferred and deduplicated, so asking while rendering is safe.
  if (name === undefined) cache.request([userId]);
  return name ?? UNKNOWN_COLLEAGUE_NAME;
}

/** An initial-letter avatar coloured from the user id, so a colleague looks the same everywhere. */
export function ColleagueAvatar({
  userId,
  name,
  size = "sm",
}: {
  readonly userId: string;
  readonly name: string;
  readonly size?: "xs" | "sm";
}) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-medium text-white",
        size === "xs" ? "size-4 text-4xs" : "size-5 text-2xs",
      )}
      style={{ backgroundColor: colleagueAvatarColor(userId) }}
    >
      {colleagueInitial(name)}
    </span>
  );
}

/** Avatar and username on one line. */
export function Colleague({
  userId,
  className,
}: {
  readonly userId: string;
  readonly className?: string;
}) {
  const name = useColleagueName(userId);
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1.5", className)}>
      <ColleagueAvatar userId={userId} name={name} size="xs" />
      <span className="truncate">{name}</span>
    </span>
  );
}
