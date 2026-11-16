import type { LinkActivityEntry, LinkGroupId } from "@t3tools/contracts";

/**
 * The per-turn link block (#37): who the thread's peers are, what they did lately, and where
 * work should go. It is sent only when it changed since the thread's last turn, so its cost
 * stays near zero; the provider keeps earlier blocks in its history.
 */

/** About 550 tokens at four characters a token; the block never grows past it. */
export const LINK_CONTEXT_MAX_CHARS = 2200;
const ACTIVITIES_PER_PEER = 3;

export type LinkContextPeerStatus = "idle" | "working" | "online" | "offline";

export interface LinkContextPeer {
  readonly peerId: string;
  readonly name: string;
  readonly purpose: string;
  /** "local, project llm_gateway" or "remote, owner alice". */
  readonly where: string;
  readonly status: LinkContextPeerStatus;
  /** Newest first. */
  readonly activities: ReadonlyArray<LinkActivityEntry>;
}

export interface LinkContextGroup {
  readonly linkId: LinkGroupId;
  readonly name: string;
  readonly paused: boolean;
  readonly peers: ReadonlyArray<LinkContextPeer>;
}

export interface LinkContextState {
  readonly groups: ReadonlyArray<LinkContextGroup>;
}

export const LINK_ROUTING_INSTRUCTION =
  "When a request falls within a peer's purpose, assign it with t3_link_assign (the peerId in brackets) rather than doing it yourself, and tell the user you did. t3_link_activity shows more of a peer's recent work.";

const truncate = (text: string, max: number) =>
  text.length <= max ? text : `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;

const hhmm = (iso: string) => {
  const match = /T(\d{2}:\d{2})/.exec(iso);
  return match === null ? "" : `${match[1]}Z `;
};

const activityLine = (entry: LinkActivityEntry) =>
  `${hhmm(entry.at)}${entry.askedBy} asked: ${entry.summary} (${entry.outcome})`;

interface Detail {
  readonly activities: number;
  readonly purposeMax: number;
  readonly where: boolean;
}

const DETAILS: ReadonlyArray<Detail> = [
  { activities: ACTIVITIES_PER_PEER, purposeMax: 200, where: true },
  { activities: 1, purposeMax: 200, where: true },
  { activities: 0, purposeMax: 200, where: true },
  { activities: 0, purposeMax: 80, where: false },
  { activities: 0, purposeMax: 40, where: false },
];

const peerLine = (peer: LinkContextPeer, detail: Detail) => {
  const purpose = peer.purpose.trim() === "" ? "no purpose set" : peer.purpose;
  const status = detail.where ? `${peer.where}; ${peer.status}` : peer.status;
  const lines = [
    `- [${peer.peerId}] ${peer.name}: ${truncate(purpose, detail.purposeMax)} (${status})`,
  ];
  for (const entry of peer.activities.slice(0, detail.activities)) {
    lines.push(`  · ${truncate(activityLine(entry), 200)}`);
  }
  return lines;
};

const groupHeader = (group: LinkContextGroup) =>
  `Link group "${group.name}"${group.paused ? " (paused: no new tasks)" : ""}. Your peers:`;

const renderAt = (state: LinkContextState, detail: Detail) => {
  const lines = ["You are linked with other threads (fwai)."];
  for (const group of state.groups) {
    lines.push(groupHeader(group));
    for (const peer of group.peers) lines.push(...peerLine(peer, detail));
  }
  lines.push(LINK_ROUTING_INSTRUCTION);
  return lines.join("\n");
};

/** Fits `lines`, then `closing`, into `max` characters, saying how many lines were cut. */
const fitLines = (
  lines: ReadonlyArray<string>,
  closing: string | null,
  max: number,
  seeMore: string,
) => {
  const kept: Array<string> = [];
  let used = closing === null ? 0 : closing.length + 1;
  for (const [index, line] of lines.entries()) {
    const marker = `… ${lines.length - index} more; see ${seeMore}.`;
    const reserve = index < lines.length - 1 ? marker.length + 1 : 0;
    if (used + line.length + 1 + reserve > max) {
      kept.push(marker);
      break;
    }
    kept.push(line);
    used += line.length + 1;
  }
  if (closing !== null) kept.push(closing);
  return truncate(kept.join("\n"), max);
};

/** The whole block. Large groups drop activities, then detail, then peers, to stay under the cap. */
export function renderLinkContext(
  state: LinkContextState,
  max: number = LINK_CONTEXT_MAX_CHARS,
): string {
  for (const detail of DETAILS) {
    const text = renderAt(state, detail);
    if (text.length <= max) return text;
  }
  const detail = DETAILS[DETAILS.length - 1]!;
  const lines = ["You are linked with other threads (fwai)."];
  for (const group of state.groups) {
    lines.push(groupHeader(group));
    for (const peer of group.peers) lines.push(...peerLine(peer, detail));
  }
  return fitLines(lines, LINK_ROUTING_INSTRUCTION, max, "t3_link_peers");
}

/** What changed since `previous`, or null when nothing did. */
export function renderLinkContextUpdate(
  previous: LinkContextState,
  next: LinkContextState,
  max: number = LINK_CONTEXT_MAX_CHARS,
): string | null {
  const lines: Array<string> = [];
  for (const group of previous.groups) {
    if (!next.groups.some((candidate) => candidate.linkId === group.linkId)) {
      lines.push(`You left link group "${group.name}".`);
    }
  }
  for (const group of next.groups) {
    const before = previous.groups.find((candidate) => candidate.linkId === group.linkId);
    if (before === undefined) {
      lines.push(groupHeader(group));
      for (const peer of group.peers) lines.push(...peerLine(peer, DETAILS[1]!));
      continue;
    }
    const changes: Array<string> = [];
    if (before.paused !== group.paused) {
      changes.push(group.paused ? "The group is paused: no new tasks." : "The group is resumed.");
    }
    for (const peer of before.peers) {
      if (!group.peers.some((candidate) => candidate.peerId === peer.peerId)) {
        changes.push(`- ${peer.name} left the group.`);
      }
    }
    for (const peer of group.peers) {
      const held = before.peers.find((candidate) => candidate.peerId === peer.peerId);
      if (held === undefined) {
        changes.push(`+ joined: ${peerLine(peer, DETAILS[2]!)[0]!.slice(2)}`);
      } else {
        if (held.purpose !== peer.purpose) {
          changes.push(`${peer.name} [${peer.peerId}] now owns: ${truncate(peer.purpose, 200)}`);
        }
        if (held.status !== peer.status) changes.push(`${peer.name} is now ${peer.status}.`);
      }
      const seen = new Set(held?.activities.map((entry) => entry.id) ?? []);
      for (const entry of peer.activities.slice(0, ACTIVITIES_PER_PEER)) {
        if (!seen.has(entry.id)) {
          changes.push(`· ${peer.name}: ${truncate(activityLine(entry), 200)}`);
        }
      }
    }
    if (changes.length > 0) lines.push(`Link group "${group.name}" changed:`, ...changes);
  }
  if (lines.length === 0) return null;
  const update = fitLines(["Link update (fwai):", ...lines], null, max, "t3_link_activity");
  const full = renderLinkContext(next, max);
  // A short update that grows past the full block is not short; send the block instead.
  return next.groups.length > 0 && update.length >= full.length ? full : update;
}
