import { LinkGroupId } from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";

import {
  LINK_CONTEXT_MAX_CHARS,
  LINK_ROUTING_INSTRUCTION,
  type LinkContextGroup,
  type LinkContextPeer,
  type LinkContextState,
  renderLinkContext,
  renderLinkContextUpdate,
} from "./LinkContext.ts";

const peer = (index: number, overrides: Partial<LinkContextPeer> = {}): LinkContextPeer => ({
  peerId: `lnk_1:${index}`,
  name: `thread ${index}`,
  purpose: `owns repository ${index}`,
  where: `local, project repo-${index}`,
  status: "idle",
  activities: [],
  ...overrides,
});

const group = (peers: ReadonlyArray<LinkContextPeer>, name = "Work"): LinkContextGroup => ({
  linkId: LinkGroupId.make(`link:${name}`),
  name,
  paused: false,
  peers,
});

const entry = (id: string, summary: string) => ({
  id,
  askedBy: "the user",
  summary,
  outcome: "completed" as const,
  at: "2026-11-12T14:02:00.000Z",
});

describe("link context", () => {
  it("lists peers with purpose, location, status, recent activity and the routing rule", () => {
    const text = renderLinkContext({
      groups: [
        group([
          peer(2, {
            name: "llm_gateway thread",
            purpose: "owns llm_gateway",
            activities: [entry("run:1", "Added the /v1/scopes endpoint.")],
          }),
        ]),
      ],
    });
    assert.include(
      text,
      "[lnk_1:2] llm_gateway thread: owns llm_gateway (local, project repo-2; idle)",
    );
    assert.include(text, "14:02Z the user asked: Added the /v1/scopes endpoint. (completed)");
    assert.include(text, LINK_ROUTING_INSTRUCTION);
  });

  it("stays under the cap for a large group and many groups", () => {
    const longPurpose = "owns a very long list of services and follows its own AGENTS.md ".repeat(
      4,
    );
    const busy = (index: number) =>
      peer(index, {
        purpose: longPurpose,
        activities: Array.from({ length: 10 }, (_, item) =>
          entry(
            `run:${index}:${item}`,
            "Refactored the provider registry and fixed the tests.".repeat(3),
          ),
        ),
      });
    const state: LinkContextState = {
      groups: Array.from({ length: 6 }, (_, groupIndex) =>
        group(
          Array.from({ length: 7 }, (_, index) => busy(groupIndex * 10 + index)),
          `Group ${groupIndex}`,
        ),
      ),
    };
    const text = renderLinkContext(state);
    assert.isAtMost(text.length, LINK_CONTEXT_MAX_CHARS);
    assert.include(text, LINK_ROUTING_INSTRUCTION);
    assert.include(text, "more; see t3_link_peers.");

    // One full group of eight drops activities before it drops peers.
    const one = renderLinkContext({
      groups: [group(Array.from({ length: 7 }, (_, index) => busy(index + 2)))],
    });
    assert.isAtMost(one.length, LINK_CONTEXT_MAX_CHARS);
    for (let index = 2; index < 9; index++) assert.include(one, `[lnk_1:${index}]`);

    const grown: LinkContextState = {
      groups: state.groups.map((current) => ({
        ...current,
        peers: current.peers.map((candidate) => ({
          ...candidate,
          status: "working" as const,
          activities: [entry(`new:${candidate.peerId}`, "Something new."), ...candidate.activities],
        })),
      })),
    };
    const update = renderLinkContextUpdate(state, grown);
    assert.isNotNull(update);
    assert.isAtMost(update!.length, LINK_CONTEXT_MAX_CHARS);
  });

  it("says nothing when nothing changed, and only what changed otherwise", () => {
    const before: LinkContextState = { groups: [group([peer(2), peer(3)])] };
    assert.isNull(renderLinkContextUpdate(before, before));

    const after: LinkContextState = {
      groups: [
        group([
          peer(2, { status: "working", activities: [entry("run:9", "Deployed staging.")] }),
          peer(4, { name: "docs thread", purpose: "owns the docs" }),
        ]),
      ],
    };
    const update = renderLinkContextUpdate(before, after)!;
    assert.include(update, "thread 2 is now working.");
    assert.include(update, "· thread 2: 14:02Z the user asked: Deployed staging. (completed)");
    assert.include(update, "- thread 3 left the group.");
    assert.include(update, "+ joined: [lnk_1:4] docs thread: owns the docs");
    assert.notInclude(update, LINK_ROUTING_INSTRUCTION);
    assert.isBelow(update.length, renderLinkContext(after).length);

    assert.include(renderLinkContextUpdate(after, { groups: [] })!, 'You left link group "Work".');
  });
});
