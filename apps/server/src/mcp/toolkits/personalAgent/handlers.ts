import * as Effect from "effect/Effect";

import * as PersonalAgentService from "../../../personalAgent/PersonalAgentService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { PersonalAgentToolkit } from "./tools.ts";

const callerThread = (tool: string) =>
  McpInvocationContext.McpInvocationContext.pipe(
    Effect.flatMap((scope) => McpInvocationContext.requireThreadScope(scope, tool)),
    Effect.map((scope) => scope.thread.threadId),
  );

const handlers = {
  t3_agent_request: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_request");
      const service = yield* PersonalAgentService.PersonalAgentService;
      const request = yield* service.ask({
        threadId,
        toAccountId: input.to,
        body: input.body,
        ...(input.context === undefined ? {} : { context: input.context }),
      });
      return { requestId: request.id, status: request.status };
    }),
  ),
  t3_agent_colleagues: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_colleagues");
      const service = yield* PersonalAgentService.PersonalAgentService;
      return { colleagues: yield* service.colleagues(threadId) };
    }),
  ),
  t3_agent_inbox: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_inbox");
      const service = yield* PersonalAgentService.PersonalAgentService;
      return { requests: yield* service.inbox(threadId) };
    }),
  ),
  t3_agent_propose: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_propose");
      const service = yield* PersonalAgentService.PersonalAgentService;
      const request = yield* service.propose({
        callerThreadId: threadId,
        requestId: input.requestId,
        proposal: {
          summary: input.summary,
          action: input.action,
          draft: input.draft,
          disclosure: input.disclosure,
          suspicious: input.suspicious ?? [],
        },
      });
      return { requestId: request.requestId, status: request.outcome };
    }),
  ),
  t3_agent_thread_list: McpToolAccess.readsAsCaller(() =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_thread_list");
      const service = yield* PersonalAgentService.PersonalAgentService;
      return { threads: yield* service.listThreads(threadId) };
    }),
  ),
  t3_agent_thread_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_thread_read");
      const service = yield* PersonalAgentService.PersonalAgentService;
      return { messages: yield* service.readThread(threadId, input.threadId) };
    }),
  ),
  t3_agent_prior_request_read: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const threadId = yield* callerThread("t3_agent_prior_request_read");
      const service = yield* PersonalAgentService.PersonalAgentService;
      return yield* service.readPriorRequest(threadId, input.requestId);
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof PersonalAgentToolkit.tools>;

export const layer = McpToolAccess.toLayer(PersonalAgentToolkit, handlers);
