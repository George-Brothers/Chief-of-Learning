import { describe, it, expect } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { Markdown, parseMarkdown, parseInline, safeHref } from "@/app/dashboard/markdown";

const render = (source: string) => renderToStaticMarkup(createElement(Markdown, { source }));

// A realistic Study Map excerpt — the shape that used to reach the page as literal characters.
const NOTION_DOC = [
  "## Week focus",
  "",
  "Pin down **是** before plain verbs. See the [HSK list](https://example.com/hsk).",
  "",
  "- 25 min CharWB 3-1",
  "- 25 min listening — pick a source",
  "",
  "### Watch",
  "1. Tone pairs (三声 + 三声)",
  "2. Measure words",
].join("\n");

describe("markdown parser", () => {
  it("turns headings, bullets and bold into structure instead of literal characters", () => {
    const blocks = parseMarkdown(NOTION_DOC);
    expect(blocks[0]).toMatchObject({ t: "h", level: 2 });
    expect(blocks.some((b) => b.t === "ul" && b.items.length === 2)).toBe(true);
    expect(blocks.some((b) => b.t === "ol" && b.items.length === 2)).toBe(true);
    const para = blocks.find((b) => b.t === "p")!;
    expect(para).toMatchObject({ t: "p" });
    if (para.t === "p") {
      expect(para.c.some((n) => n.t === "strong")).toBe(true);
      expect(para.c.some((n) => n.t === "link")).toBe(true);
    }
  });

  it("keeps CJK text intact through inline parsing", () => {
    const nodes = parseInline("**是** 不是 · 学习中文");
    expect(nodes[0]).toEqual({ t: "strong", c: [{ t: "text", v: "是" }] });
    expect(nodes.map((n) => (n.t === "text" ? n.v : "")).join("")).toContain("不是 · 学习中文");
  });

  it("merges wrapped paragraph lines but keeps blank-line breaks", () => {
    const blocks = parseMarkdown("one\ntwo\n\nthree");
    expect(blocks).toHaveLength(2);
    expect(blocks[0]).toMatchObject({ t: "p", c: [{ t: "text", v: "one two" }] });
  });

  it("treats a bullet dash as a list marker, not emphasis", () => {
    const blocks = parseMarkdown("- 25m 是-drill");
    expect(blocks[0]).toMatchObject({ t: "ul" });
    if (blocks[0].t === "ul") expect(blocks[0].items[0]).toEqual([{ t: "text", v: "25m 是-drill" }]);
  });
});

describe("Markdown rendering", () => {
  it("emits real elements and never the raw markers the learner complained about", () => {
    const html = render(NOTION_DOC);
    expect(html).toContain("<h4");
    expect(html).toContain("<ul");
    expect(html).toContain("<ol");
    expect(html).toContain("<strong>是</strong>");
    // The old page put this string straight into a div; these markers must be gone now.
    expect(html).not.toContain("##");
    expect(html).not.toContain("**");
    expect(html).not.toMatch(/^\s*- /m);
  });

  it("proves the old behavior would fail the assertions above", () => {
    // What app/dashboard/page.tsx used to do: `<div className={s.prose}>{markdown}</div>`.
    const old = renderToStaticMarkup(createElement("div", null, NOTION_DOC));
    expect(old).toContain("##");
    expect(old).toContain("**");
    expect(old).not.toContain("<h4");
  });

  it("escapes HTML in the source rather than executing it", () => {
    const html = render('<img src=x onerror="alert(1)"> <script>alert(2)</script>');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;img");
  });

  it("refuses javascript: and data: links, showing the URL as text", () => {
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("data:text/html,<script>")).toBeNull();
    expect(safeHref(" https://example.com ")).toBe("https://example.com");
    const html = render("[click](javascript:alert(1))");
    expect(html).not.toContain("<a");
    expect(html).toContain("click");
  });

  // The URL parser treats a backslash as a slash for http/https, so every one of these resolves to
  // https://evil.com even though none of them starts with `//`. Notion authors the markdown these
  // hrefs come from, so a link that *looks* internal must actually stay internal.
  it("refuses paths that resolve off-origin via backslashes", () => {
    for (const href of ["/\\evil.com", "/\\\\evil.com", "\\/evil.com", "\\\\evil.com", "//evil.com"]) {
      expect(safeHref(href)).toBeNull();
    }
  });

  // Tabs and newlines are stripped by the parser *before* the scheme is read, so `java<tab>script:`
  // is a javascript: URL, and `/ev<newline>il.com` is not the path it appears to be.
  it("refuses hrefs that hide their scheme or target behind tabs and newlines", () => {
    expect(safeHref("java\tscript:alert(1)")).toBeNull();
    expect(safeHref("java\nscript:alert(1)")).toBeNull();
    expect(safeHref("jav\rascript:alert(1)")).toBeNull();
    expect(safeHref("/\t\\evil.com")).toBeNull();
    expect(safeHref("/\n/evil.com")).toBeNull();
    expect(safeHref("javascript:alert(1)")).toBeNull();
  });

  it("still allows ordinary paths, fragments and web links", () => {
    expect(safeHref("/dashboard")).toBe("/dashboard");
    expect(safeHref("/dashboard?tab=map#today")).toBe("/dashboard?tab=map#today");
    expect(safeHref("#today")).toBe("#today");
    expect(safeHref("https://example.com/hsk")).toBe("https://example.com/hsk");
    expect(safeHref("http://example.com/hsk")).toBe("http://example.com/hsk");
    expect(safeHref("mailto:lucy@example.com")).toBe("mailto:lucy@example.com");
    const html = render("[map](/dashboard)");
    expect(html).toContain('href="/dashboard"');
  });

  it("marks external links noopener", () => {
    const html = render("[HSK](https://example.com/hsk)");
    expect(html).toContain('rel="noopener noreferrer"');
  });
});

describe("dashboard client safety", () => {
  it("uses no dangerouslySetInnerHTML anywhere in the dashboard or login UI", () => {
    const dir = join(process.cwd(), "app", "dashboard");
    const files = readdirSync(dir)
      .filter((f) => f.endsWith(".tsx"))
      .map((f) => join(dir, f))
      .concat(join(process.cwd(), "app", "login", "page.tsx"));
    // Matches the prop being *used* (`dangerouslySetInnerHTML={...}`), not named in a comment.
    for (const f of files) {
      expect(readFileSync(f, "utf8"), f).not.toMatch(/dangerouslySetInnerHTML\s*[=:]/);
    }
  });
});
