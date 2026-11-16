import { describe, expect, it } from "vite-plus/test";

import { linkCommandStage, parseLinkCommand } from "./linkCommand.ts";

const thread = (id: string, title: string) => ({ id, title });
// Newest first, as the composer lists them.
const candidates = [
  thread("math-new", "数学线程"),
  thread("math-old", "数学线程"),
  thread("calc", "在此进行所有数学运算"),
  thread("release", "Release notes"),
  thread("rel", "Release"),
];

const parse = (args: string, preferred?: string) =>
  parseLinkCommand(args, candidates, (candidate) => candidate.id === preferred);

describe("parseLinkCommand", () => {
  it("reads a bracketed thread, its purpose, own: and group:", () => {
    expect(
      parse("[在此进行所有数学运算] 负责所有数学计算 own: 负责户型和面积测量 group: 装修"),
    ).toEqual({
      target: candidates[2],
      targetName: "在此进行所有数学运算",
      purpose: "负责所有数学计算",
      ownPurpose: "负责户型和面积测量",
      group: "装修",
    });
  });

  it("gives null for whatever is left out", () => {
    expect(parse("[数学线程] 只做计算，不改文件")).toMatchObject({
      purpose: "只做计算，不改文件",
      ownPurpose: null,
      group: null,
    });
    expect(parse("[数学线程] group: 装修")).toMatchObject({
      purpose: null,
      ownPurpose: null,
      group: "装修",
    });
    expect(parse("[数学线程] own: 负责户型设计")).toMatchObject({
      purpose: null,
      ownPurpose: "负责户型设计",
      group: null,
    });
  });

  it("takes keywords in any order, any case, with either colon and optional spaces", () => {
    expect(parse("[Release notes] drafts them GROUP：Docs  Own : edits")).toMatchObject({
      purpose: "drafts them",
      ownPurpose: "edits",
      group: "Docs",
    });
    // Chinese text may run straight into a keyword; an English word ending in one does not count.
    expect(parse("[数学线程]只做计算own：设计")).toMatchObject({
      purpose: "只做计算",
      ownPurpose: "设计",
    });
    expect(parse("[Release notes] known: issues")).toMatchObject({
      purpose: "known: issues",
      ownPurpose: null,
    });
  });

  it("treats empty values as not given, and the last of a repeated keyword wins", () => {
    expect(parse("[Release notes]   group:  own:")).toMatchObject({
      purpose: null,
      ownPurpose: null,
      group: null,
    });
    expect(parse("[Release notes] group: A group: B")).toMatchObject({ group: "B" });
    expect(parse("[Release notes] own: a own:")).toMatchObject({ ownPurpose: null });
  });

  it("matches a typed title by its longest prefix, ignoring case", () => {
    expect(parse("release NOTES keeps the changelog")).toMatchObject({
      target: candidates[3],
      purpose: "keeps the changelog",
    });
    expect(parse("Release ships it")).toMatchObject({
      target: candidates[4],
      purpose: "ships it",
    });
    expect(parse("数学线程只做计算")).toMatchObject({ target: candidates[0], purpose: "只做计算" });
  });

  it("picks the newest of two same-titled threads, unless the other was the suggestion picked", () => {
    expect(parse("[数学线程]").target?.id).toBe("math-new");
    expect(parse("[数学线程]", "math-old").target?.id).toBe("math-old");
  });

  it("names no thread for an unknown title, bracketed or not", () => {
    expect(parse("[Nothing like it] purpose group: G")).toMatchObject({
      target: null,
      targetName: "Nothing like it",
    });
    expect(parse("Nothing like it group: G")).toMatchObject({
      target: null,
      targetName: "Nothing like it",
    });
    expect(parse("")).toMatchObject({ target: null, targetName: "" });
  });
});

describe("linkCommandStage", () => {
  it("suggests threads until one is named", () => {
    expect(linkCommandStage("", candidates)).toEqual({ kind: "thread", query: "" });
    expect(linkCommandStage("Rel", candidates)).toEqual({ kind: "thread", query: "Rel" });
    // "Release" names a thread, but "Release notes" is still a match.
    expect(linkCommandStage("Release", candidates)).toEqual({ kind: "thread", query: "Release" });
    expect(linkCommandStage("[Unknown] x", candidates).kind).toBe("thread");
  });

  it("hints at the details once a thread is named", () => {
    expect(linkCommandStage("[Release] ", candidates)).toEqual({ kind: "details" });
    expect(linkCommandStage("数学线程 只做计算 own: x", candidates)).toEqual({ kind: "details" });
  });

  it("suggests groups while the group's name is typed, and says where it starts", () => {
    const args = "[Release] ships group:  装";
    expect(linkCommandStage(args, candidates)).toEqual({
      kind: "group",
      query: "装",
      start: args.indexOf("装"),
    });
    expect(linkCommandStage(" [Release] group:", candidates)).toEqual({
      kind: "group",
      query: "",
      start: " [Release] group:".length,
    });
  });
});
