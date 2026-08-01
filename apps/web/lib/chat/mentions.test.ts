import { describe, expect, it } from "vitest";

import { extractMentions, mentionQueryAt } from "./mentions";

const RESEARCHER = { id: "agt_researcher00001a", name: "Researcher" };
const RES = { id: "agt_res000000000001a", name: "Res" };
const RESEARCH_BOT = { id: "agt_researchbot0001a", name: "Research Bot" };

describe("extractMentions", () => {
  it("resolves a plain @Name to the target id", () => {
    expect(extractMentions("hey @Researcher, take a look", [RESEARCHER])).toEqual([RESEARCHER.id]);
  });

  it("matches case-insensitively", () => {
    expect(extractMentions("@researcher go", [RESEARCHER])).toEqual([RESEARCHER.id]);
    expect(extractMentions("@RESEARCHER go", [RESEARCHER])).toEqual([RESEARCHER.id]);
  });

  it("is boundary-aware: @Researcher does not also mention Res", () => {
    expect(extractMentions("@Researcher please", [RES, RESEARCHER])).toEqual([RESEARCHER.id]);
  });

  it("matches multi-word names", () => {
    expect(extractMentions("summon @Research Bot now", [RESEARCH_BOT])).toEqual([RESEARCH_BOT.id]);
  });

  it("accepts trailing punctuation after the name", () => {
    expect(extractMentions("thanks @Researcher!", [RESEARCHER])).toEqual([RESEARCHER.id]);
    expect(extractMentions("(@Researcher)", [RESEARCHER])).toEqual([RESEARCHER.id]);
  });

  it("ignores mid-word and doubled-@ tokens", () => {
    expect(extractMentions("email me a@Researcher thing", [RESEARCHER])).toEqual([]);
    expect(extractMentions("@@Researcher", [RESEARCHER])).toEqual([]);
  });

  it("returns every distinct mentioned target once", () => {
    const content = "@Researcher and @Research Bot, split it. @Researcher first.";
    expect(extractMentions(content, [RESEARCHER, RESEARCH_BOT])).toEqual([
      RESEARCHER.id,
      RESEARCH_BOT.id,
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(extractMentions("no mentions here", [RESEARCHER])).toEqual([]);
    expect(extractMentions("@Unknown agent", [RESEARCHER])).toEqual([]);
  });
});

describe("mentionQueryAt", () => {
  it("finds the in-progress token right before the caret", () => {
    expect(mentionQueryAt("hello @re", 9)).toEqual({ query: "re", start: 6 });
  });

  it("returns an empty query immediately after typing @", () => {
    expect(mentionQueryAt("@", 1)).toEqual({ query: "", start: 0 });
    expect(mentionQueryAt("hi @", 4)).toEqual({ query: "", start: 3 });
  });

  it("requires the @ to start the text or follow whitespace", () => {
    expect(mentionQueryAt("a@b", 3)).toBeNull();
    expect(mentionQueryAt("mail me x@y", 11)).toBeNull();
  });

  it("does not trigger once the token is completed with a space", () => {
    expect(mentionQueryAt("@Researcher ", 12)).toBeNull();
  });

  it("only looks at text before the caret", () => {
    expect(mentionQueryAt("@re after", 3)).toEqual({ query: "re", start: 0 });
  });
});
