import { describe, it, expect } from "vitest";
import { toMarkdown } from "../agent/convert";

describe("toMarkdown", () => {
  it("passes through plain text", () => {
    expect(toMarkdown("note.txt", "  hello\nworld  ")).toBe("hello\nworld");
  });

  it("strips VTT timestamps and headers", () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:03.000
你好 tutor here

2
00:00:03.000 --> 00:00:06.000
today we study hobbies`;
    expect(toMarkdown("lesson.vtt", vtt)).toBe("你好 tutor here\ntoday we study hobbies");
  });

  it("strips SRT timestamps", () => {
    const srt = `1
00:00:01,000 --> 00:00:03,000
line one

2
00:00:03,000 --> 00:00:06,000
line two`;
    expect(toMarkdown("lesson.srt", srt)).toBe("line one\nline two");
  });
});
