import * as Effect from "effect/Effect";

import * as LinkService from "../../../link/LinkService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { assertTargetWithinLimits, loadCaller, unavailable } from "../../threadAccess.ts";
import { LinkToolkit } from "./tools.ts";

const handlers = {
  t3_link_peers: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_link_peers");
      const links = yield* LinkService.LinkService;
      return { peers: yield* links.peers(caller.thread.threadId) };
    }),
  ),
  t3_link_activity: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_link_activity");
      const links = yield* LinkService.LinkService;
      const entries = yield* links.activity(caller.thread.threadId, input.peerId);
      return {
        entries: entries.map(({ id: _id, ...entry }) => entry),
      };
    }),
  ),
  t3_link_assign: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const caller = yield* loadCaller();
      const scope = yield* McpInvocationContext.requireThreadScope(caller.scope, "t3_link_assign");
      const threadId = scope.thread.threadId;
      const links = yield* LinkService.LinkService;
      const peer = yield* links.resolvePeer(threadId, input.peerId);
      // A task may not make its assignee act in a broader mode than the requester.
      const target = yield* caller.threads
        .getThreadShell(peer.threadId)
        .pipe(Effect.mapError(unavailable));
      if (target !== null) yield* assertTargetWithinLimits(caller.limits, target);
      return yield* links.assign({
        callerThreadId: threadId,
        peerId: input.peerId,
        task: input.task,
      });
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof LinkToolkit.tools>;

export const layer = McpToolAccess.toLayer(LinkToolkit, handlers);
