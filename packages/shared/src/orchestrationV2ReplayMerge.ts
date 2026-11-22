import type { OrchestrationV2DomainEvent, OrchestrationV2TurnItem } from "@t3tools/contracts";

type ReplayEvent = {
  readonly kind: "event";
  readonly sequence: number;
  readonly event: OrchestrationV2DomainEvent;
};

/**
 * Turn item types whose updates only replace the item's body. Others are kept
 * verbatim: interrupt items change other items' visibility, user messages and
 * plans carry intent, and subagent bodies are restored from the previous version.
 */
const MERGEABLE_TURN_ITEM_TYPES: ReadonlySet<OrchestrationV2TurnItem["type"]> = new Set([
  "assistant_message",
  "reasoning",
  "command_execution",
  "file_change",
  "file_search",
  "web_search",
  "dynamic_tool",
]);

/**
 * Whole-entity upserts the client applies by id without reading the previous version.
 * Excluded: `provider-turn.updated` keeps `tokenUsage`, `subagent.updated` restores
 * bodies from the previous version, and run/attempt updates change item visibility.
 */
function mergeKey(event: OrchestrationV2DomainEvent): string | null {
  switch (event.type) {
    case "message.updated":
    case "node.updated":
      return `${event.type}\u0000${event.payload.id}`;
    case "turn-item.updated":
      return MERGEABLE_TURN_ITEM_TYPES.has(event.payload.type)
        ? `${event.type}\u0000${event.payload.id}`
        : null;
    default:
      return null;
  }
}

// A turn item's run and ordinal decide where it is placed and whether a partial
// timeline keeps it, so a change there starts a new group instead of moving it.
function placement(event: OrchestrationV2DomainEvent): string {
  return event.type === "turn-item.updated"
    ? `${event.payload.runId ?? ""}\u0000${event.payload.ordinal}`
    : "";
}

/**
 * Deletes and rollbacks: rare, and they hide or remove entities a merged
 * version may have moved past. Removals of entities never merged (a provider
 * session detaching) stay in the replay.
 */
function removesState(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "thread.deleted":
    case "checkpoint.rollback-requested":
      return true;
    case "run.updated":
      return event.payload.status === "rolled_back";
    default:
      return false;
  }
}

export type MergedThreadReplay<T> =
  | { readonly mode: "replay"; readonly items: ReadonlyArray<T> }
  | { readonly mode: "snapshot" };

/**
 * Collapses each allowed entity's updates into one event: first position, last
 * value. The survivor keeps the first version's sequence, so sequences stay
 * increasing and a cut-off delivery can only leave the client's cursor behind.
 * Applying the result equals applying every event in order.
 */
export function mergeThreadReplay<T extends ReplayEvent>(
  items: ReadonlyArray<T>,
): MergedThreadReplay<T> {
  const merged: T[] = [];
  const groups = new Map<string, { readonly index: number; readonly placement: string }>();
  for (const item of items) {
    if (removesState(item.event)) return { mode: "snapshot" };
    const key = mergeKey(item.event);
    if (key === null) {
      merged.push(item);
      continue;
    }
    const group = groups.get(key);
    const itemPlacement = placement(item.event);
    if (group !== undefined && group.placement === itemPlacement) {
      merged[group.index] = { ...item, sequence: merged[group.index]!.sequence };
      continue;
    }
    groups.set(key, { index: merged.length, placement: itemPlacement });
    merged.push(item);
  }
  return { mode: "replay", items: merged };
}
