import { LinkError, OrchestratorMcpFailure, TrimmedNonEmptyString } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";

import * as LinkService from "../../../link/LinkService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const dependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  LinkService.LinkService,
];

const failure = Schema.Union([LinkError, OrchestratorMcpFailure]);

export const LinkPeer = Schema.Struct({
  peerId: Schema.String,
  linkName: Schema.String,
  title: Schema.String,
  purpose: Schema.String,
  location: Schema.Literals(["local", "remote"]),
  project: Schema.String,
  online: Schema.Boolean,
  paused: Schema.Boolean,
  environment: Schema.optional(Schema.String),
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  requiresApproval: Schema.optional(Schema.Boolean),
});

const LinkPeersTool = Tool.make("t3_link_peers", {
  description:
    "List the threads linked with yours and what each owns (`purpose`). Assign work to one with `t3_link_assign`. A `remote` peer runs in another environment, maybe a colleague's (`owner`): it shares no files with you, may be offline, and with `requiresApproval` its owner approves its commands first.",
  success: Schema.Struct({ peers: Schema.Array(LinkPeer) }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "List linked peers")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const LinkAssignTool = Tool.make("t3_link_assign", {
  description:
    "Assign `task` to a linked peer by `peerId`. It runs in that thread when it is free; its final reply comes back to you automatically and wakes you, so do not poll. Write the task so it stands alone: the peer has no part of your conversation. A remote peer shares no files: put the content it needs in the task, not local paths. It may wait for its owner's approval, so carry on rather than wait. `task_status`/`task_cancel` take the returned `taskId`. Errors: not_a_peer, peer_offline, not_authorized, hop_limit, cycle, rate_limited, link_paused, chain_stopped.",
  parameters: Schema.Struct({
    peerId: TrimmedNonEmptyString,
    task: TrimmedNonEmptyString,
  }),
  success: Schema.Struct({ taskId: Schema.String, peerId: Schema.String }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Assign work to a linked peer")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.OpenWorld, true);

const LinkActivityTool = Tool.make("t3_link_activity", {
  description:
    "Recent work of your linked peers, newest first: who asked, a one-line summary, the outcome and when. Pass `peerId` for one peer, or nothing for every peer in your groups. Use it to decide which peer owns a request.",
  parameters: Schema.Struct({ peerId: Schema.optional(TrimmedNonEmptyString) }),
  success: Schema.Struct({
    entries: Schema.Array(
      Schema.Struct({
        peerId: Schema.String,
        peerTitle: Schema.String,
        linkName: Schema.String,
        askedBy: Schema.String,
        summary: Schema.String,
        outcome: Schema.Literals(["completed", "failed", "stopped"]),
        at: Schema.String,
      }),
    ),
  }),
  failure,
  failureMode: "return",
  dependencies,
})
  .annotate(Tool.Title, "Read linked peers' recent activity")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

export const LinkToolkit = Toolkit.make(LinkPeersTool, LinkAssignTool, LinkActivityTool);
