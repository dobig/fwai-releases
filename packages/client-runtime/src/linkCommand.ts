/**
 * `/link <thread> [its purpose] [own: my purpose] [group: group name]`. A picked suggestion is
 * inserted as `[title] `, so the brackets say where a title with spaces ends.
 */

export type LinkCommandKeyword = "own" | "group";

interface KeywordMatch {
  readonly keyword: LinkCommandKeyword;
  readonly start: number;
  /** Just after the colon. */
  readonly valueStart: number;
}

// English keywords only; a letter right before (`known:`) is part of another word. Chinese text
// may run straight into the keyword, so only ASCII word characters count.
const KEYWORD = /(?<![A-Za-z0-9_])(own|group)\s*[:：]/giu;

function keywordMatches(text: string): ReadonlyArray<KeywordMatch> {
  return [...text.matchAll(KEYWORD)].map((match) => ({
    keyword: match[1]?.toLowerCase() === "own" ? "own" : "group",
    start: match.index,
    valueStart: match.index + match[0].length,
  }));
}

const startsWithIgnoringCase = (text: string, prefix: string) =>
  text.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase();

interface NamedThread<T> {
  readonly target: T | null;
  /** Where the thread's name ends in the text. */
  readonly end: number;
  readonly bracketed: boolean;
  /** The thread as typed, for messages. */
  readonly name: string;
}

function nameThread<T extends { readonly title: string }>(
  text: string,
  candidates: ReadonlyArray<T>,
  isPreferred: (candidate: T) => boolean,
): NamedThread<T> {
  const longestMatch = (wrap: (title: string) => string) => {
    let best: { readonly title: string; readonly matches: T[] } | null = null;
    for (const candidate of candidates) {
      const title = candidate.title.trim();
      if (title === "" || !startsWithIgnoringCase(text, wrap(title))) continue;
      if (best === null || title.length > best.title.length) {
        best = { title, matches: [candidate] };
      } else if (title.toLowerCase() === best.title.toLowerCase()) {
        best.matches.push(candidate);
      }
    }
    if (best === null) return null;
    // Candidates come newest first; the suggestion the person picked beats an older namesake.
    const target = best.matches.find(isPreferred) ?? best.matches[0] ?? null;
    return { target, end: wrap(best.title).length, name: best.title };
  };
  const bracketed = text.startsWith("[") ? longestMatch((title) => `[${title}]`) : null;
  if (bracketed !== null) return { ...bracketed, bracketed: true };
  const plain = longestMatch((title) => title);
  if (plain !== null) return { ...plain, bracketed: false };
  const close = text.indexOf("]");
  if (text.startsWith("[") && close > 0) {
    return { target: null, end: close + 1, bracketed: true, name: text.slice(1, close).trim() };
  }
  const end = keywordMatches(text)[0]?.start ?? text.length;
  return { target: null, end, bracketed: false, name: text.slice(0, end).trim() };
}

export interface LinkCommandArgs<T> {
  /** Null when no candidate has the title typed. */
  readonly target: T | null;
  /** The thread as typed: the bracketed title, or the text before the first keyword. */
  readonly targetName: string;
  /** The rest are null when not given, or given empty. */
  readonly purpose: string | null;
  readonly ownPurpose: string | null;
  readonly group: string | null;
}

const given = (value: string) => {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
};

/**
 * Reads what follows `/link`. The thread is a bracketed title, or the longest candidate title the
 * text starts with (case-insensitive); candidates are newest first, so the newest wins a tie.
 * Its purpose runs up to the first keyword. A repeated keyword: the last one wins.
 */
export function parseLinkCommand<T extends { readonly title: string }>(
  args: string,
  candidates: ReadonlyArray<T>,
  isPreferred: (candidate: T) => boolean = () => false,
): LinkCommandArgs<T> {
  const text = args.trim();
  const thread = nameThread(text, candidates, isPreferred);
  const rest = text.slice(thread.end);
  const keywords = keywordMatches(rest);
  const values: Record<LinkCommandKeyword, string | null> = { own: null, group: null };
  keywords.forEach((match, index) => {
    values[match.keyword] = given(rest.slice(match.valueStart, keywords[index + 1]?.start));
  });
  return {
    target: thread.target,
    targetName: thread.name,
    purpose: given(rest.slice(0, keywords[0]?.start ?? rest.length)),
    ownPurpose: values.own,
    group: values.group,
  };
}

export type LinkCommandStage =
  /** Naming the thread: suggest threads matching `query`. */
  | { readonly kind: "thread"; readonly query: string }
  /** A thread is named; its purpose, `own:` and `group:` may follow. */
  | { readonly kind: "details" }
  /** Typing the group's name, which starts at `start` in the text. */
  | { readonly kind: "group"; readonly query: string; readonly start: number };

/** What the person is typing after `/link`, given the text up to the cursor. */
export function linkCommandStage<T extends { readonly title: string }>(
  args: string,
  candidates: ReadonlyArray<T>,
): LinkCommandStage {
  const query = args.trimStart();
  const offset = args.length - query.length;
  const thread = nameThread(query, candidates, () => false);
  const stillTyping =
    !thread.bracketed &&
    candidates.some((candidate) =>
      candidate.title.toLowerCase().includes(query.trim().toLowerCase()),
    );
  if (thread.target === null || stillTyping) return { kind: "thread", query };
  const last = keywordMatches(query.slice(thread.end)).at(-1);
  if (last?.keyword !== "group") return { kind: "details" };
  const value = query.slice(thread.end + last.valueStart);
  const name = value.trimStart();
  return {
    kind: "group",
    query: name,
    start: offset + thread.end + last.valueStart + (value.length - name.length),
  };
}
