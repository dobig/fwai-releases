import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export interface LinkTurnContextBlock {
  readonly text: string;
  /** Records the block as delivered; call once the provider took the turn. */
  readonly commit: Effect.Effect<void>;
}

export interface LinkTurnContextProvider {
  /**
   * The link block for a thread's next turn (#37), or null when nothing changed since its last
   * one. `fresh` means the provider's history no longer holds earlier blocks.
   */
  readonly forTurn: (input: {
    readonly threadId: ThreadId;
    readonly fresh: boolean;
  }) => Effect.Effect<LinkTurnContextBlock | null>;
}

const none: LinkTurnContextProvider = { forTurn: () => Effect.succeed(null) };

/**
 * RunExecutionService starts turns below the orchestrator, and LinkService needs the
 * orchestrator, so LinkService binds itself here once built. Unbound, turns carry no link block.
 */
export class LinkTurnContext extends Context.Reference<
  LinkTurnContextProvider & {
    readonly bind: (provider: LinkTurnContextProvider) => Effect.Effect<void>;
  }
>("fwai/link/LinkTurnContext", {
  defaultValue: () => ({ ...none, bind: () => Effect.void }),
}) {}

export const layer = Layer.sync(LinkTurnContext, () => {
  let bound = none;
  return {
    // The bound provider opens its own span.
    forTurn: Effect.fnUntraced(function* (input) {
      return yield* bound.forTurn(input);
    }),
    bind: Effect.fn("LinkTurnContext.bind")((provider: LinkTurnContextProvider) =>
      Effect.sync(() => {
        bound = provider;
      }),
    ),
  };
});
