import * as FwaiGateway from "@t3tools/shared/fwaiGateway";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Layer from "effect/Layer";
import type { HttpClient } from "effect/http";

import { createUsernameCache, type UsernameCache } from "./colleagues.ts";

export interface FwaiOrganizationMembersPage {
  readonly members: ReadonlyArray<FwaiGateway.FwaiGatewayOrganizationMember>;
  readonly nextCursor: string | null;
}

/** The account's organization as the UI shows it; `none` outside an organization. */
export type OrganizationLoadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly response: FwaiGateway.FwaiGatewayOrganizationResponse }
  | { readonly status: "none" }
  | { readonly status: "failed"; readonly message: string };

/**
 * `GET /v1/me/organization`, read once per directory and shared by every surface that asks
 * (team badge, team panel, composer). `load({ force: true })` reads it again.
 */
export interface OrganizationStore {
  readonly get: () => OrganizationLoadState;
  readonly load: (options?: { readonly force?: boolean }) => Promise<void>;
  readonly subscribe: (listener: () => void) => () => void;
}

/** The members directory pages at most this many members. */
const MEMBERS_PAGE_LIMIT = 200;
/** Stops paging a runaway directory; an organization this large needs search instead. */
const MEMBERS_MAX_PAGES = 10;

/**
 * The signed-in account's organization in the llm_gateway members directory (llm_gateway#629),
 * read with the user's fwai access token. Create one per account: usernames are cached for its
 * lifetime. Errors are `FwaiGatewayError`s; `404 not_org_member` means no organization.
 */
export interface FwaiOrganizationDirectory {
  /** Null outside an organization. */
  readonly getOrganization: () => Promise<FwaiGateway.FwaiGatewayOrganizationResponse | null>;
  readonly searchMembers: (query: {
    readonly q?: string;
    readonly projectId?: string;
    readonly cursor?: string;
    readonly limit?: number;
  }) => Promise<FwaiOrganizationMembersPage>;
  /** Every member, paged through; the team panel groups them by project. */
  readonly listAllMembers: () => Promise<ReadonlyArray<FwaiGateway.FwaiGatewayOrganizationMember>>;
  readonly usernames: UsernameCache;
  readonly organization: OrganizationStore;
}

class FwaiAccountSignedOutError extends Error {
  constructor() {
    super("Sign in to your fwai account first.");
  }
}

const isFwaiGatewayError = Schema.is(FwaiGateway.FwaiGatewayError);

export function isNotOrganizationMemberError(error: unknown): boolean {
  return isFwaiGatewayError(error) && error.code === "not_org_member";
}

export function createFwaiOrganizationDirectory(options: {
  readonly gateway: FwaiGateway.FwaiGatewayConfig;
  readonly httpClient: Layer.Layer<HttpClient.HttpClient>;
  readonly getAccessToken: () => Promise<string | null>;
}): FwaiOrganizationDirectory {
  const run = async <A>(
    call: (
      accessToken: string,
    ) => Effect.Effect<A, FwaiGateway.FwaiGatewayError, HttpClient.HttpClient>,
  ): Promise<A> => {
    const accessToken = await options.getAccessToken();
    if (accessToken === null) throw new FwaiAccountSignedOutError();
    const exit = await Effect.runPromiseExit(
      call(accessToken).pipe(Effect.provide(options.httpClient)),
    );
    if (Exit.isSuccess(exit)) return exit.value;
    throw Option.getOrUndefined(Exit.findErrorOption(exit)) ?? Cause.squash(exit.cause);
  };

  const usernames = createUsernameCache({
    batchLimit: FwaiGateway.FWAI_MEMBER_IDS_LIMIT,
    lookup: async (ids) => {
      try {
        const page = await run((accessToken) =>
          FwaiGateway.listOrganizationMembers(options.gateway, accessToken, {
            ids,
            limit: ids.length,
          }),
        );
        return new Map(page.members.map((member) => [member.user_id, member.username]));
      } catch (error) {
        // Outside an organization nobody resolves; remember that instead of asking again.
        if (isNotOrganizationMemberError(error)) return new Map();
        throw error;
      }
    },
  });

  const getOrganization = async () => {
    const response = await run((accessToken) =>
      FwaiGateway.getOrganization(options.gateway, accessToken),
    );
    return response.organization === null ? null : response;
  };
  const searchMembers: FwaiOrganizationDirectory["searchMembers"] = async (query) => {
    const page = await run((accessToken) =>
      FwaiGateway.listOrganizationMembers(options.gateway, accessToken, query),
    );
    return { members: page.members, nextCursor: page.next_cursor };
  };

  return {
    getOrganization,
    searchMembers,
    listAllMembers: async () => {
      const members: FwaiGateway.FwaiGatewayOrganizationMember[] = [];
      let cursor: string | null = null;
      for (let page = 0; page < MEMBERS_MAX_PAGES; page += 1) {
        const result: FwaiOrganizationMembersPage = await searchMembers({
          limit: MEMBERS_PAGE_LIMIT,
          ...(cursor === null ? {} : { cursor }),
        });
        members.push(...result.members);
        cursor = result.nextCursor;
        if (cursor === null) break;
      }
      return members;
    },
    usernames,
    organization: createOrganizationStore(getOrganization),
  };
}

const errorMessage = (error: unknown, fallback: string) =>
  error instanceof Error && error.message ? error.message : fallback;

export function createOrganizationStore(
  read: () => Promise<FwaiGateway.FwaiGatewayOrganizationResponse | null>,
): OrganizationStore {
  let state: OrganizationLoadState = { status: "loading" };
  let inFlight: Promise<void> | null = null;
  let loaded = false;
  const listeners = new Set<() => void>();
  const set = (next: OrganizationLoadState) => {
    state = next;
    for (const listener of listeners) listener();
  };
  return {
    get: () => state,
    load: (loadOptions) => {
      if (inFlight !== null) return inFlight;
      if (loaded && loadOptions?.force !== true) return Promise.resolve();
      if (state.status === "failed") set({ status: "loading" });
      inFlight = read().then(
        (response) => {
          loaded = true;
          inFlight = null;
          set(response === null ? { status: "none" } : { status: "ready", response });
        },
        (error: unknown) => {
          inFlight = null;
          // A failure is not remembered as loaded, so the next load asks again.
          set(
            isNotOrganizationMemberError(error)
              ? { status: "none" }
              : { status: "failed", message: errorMessage(error, "Could not load your team.") },
          );
          if (isNotOrganizationMemberError(error)) loaded = true;
        },
      );
      return inFlight;
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
