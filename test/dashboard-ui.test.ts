import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// The only stub here is the framework's router, which has no provider outside a Next render. The
// components themselves are the real ones.
vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: () => {}, refresh: () => {} }),
}));

import { PlanChecklist, AssignmentList, Chat, markHanzi } from "@/app/dashboard/client";
import { Meter, VerdictFlag } from "@/app/dashboard/ui";

/**
 * The dashboard's two write controls must be real controls. The previous design had no plan
 * checkboxes at all; these assertions pin the semantics so a later refactor can't quietly turn them
 * back into clickable <div>s.
 */
describe("plan checklist", () => {
  const blocks = [
    { id: "a1", text: "CharWB 3-1", minutes: 25 },
    { id: "b2", text: "是-drill", minutes: null },
  ];

  it("renders one focusable checkbox button per block", () => {
    const html = renderToStaticMarkup(createElement(PlanChecklist, { blocks }));
    const buttons = html.match(/<button[^>]*role="checkbox"/g) ?? [];
    expect(buttons).toHaveLength(2);
    expect(html).toContain('aria-checked="false"');
    expect(html).toContain('type="button"');
    // No clickable div standing in for a control.
    expect(html).not.toMatch(/<div[^>]*onclick/i);
  });

  it("shows the bracket box and the block's own minutes", () => {
    const html = renderToStaticMarkup(createElement(PlanChecklist, { blocks }));
    expect(html).toContain("[ ]");
    expect(html).toContain("25m");
    expect(html).toContain("CharWB 3-1");
    // The hanzi run is wrapped for screen readers, so the text is split across a lang span.
    expect(html).toContain('<span lang="zh-Hans">是</span>-drill');
  });

  /**
   * FAILS against the pre-fix component, which took no completedIds prop and started every render
   * with an empty state map — every box came back unticked after a reload.
   */
  it("renders a block already logged today as checked, without a click", () => {
    const html = renderToStaticMarkup(
      createElement(PlanChecklist, { blocks, completedIds: ["b2"] }),
    );
    const boxes = html.match(/aria-checked="(true|false)"/g) ?? [];
    expect(boxes).toEqual(['aria-checked="false"', 'aria-checked="true"']);
  });

  /** The live region has to exist before there is anything to announce, or it announces nothing. */
  it("mounts an empty live region up front", () => {
    const html = renderToStaticMarkup(createElement(PlanChecklist, { blocks }));
    expect(html).toMatch(/role="status" aria-live="polite"/);
  });
});

describe("assignment list", () => {
  it("gives every open assignment a real close button and an age", () => {
    const html = renderToStaticMarkup(
      createElement(AssignmentList, {
        items: [
          { id: "p1", kind: "homework", description: "Write 8 sentences", daysCarried: 4 },
          { id: "p2", kind: "drill", description: "Tone pairs", daysCarried: 0 },
        ],
      }),
    );
    expect((html.match(/<button/g) ?? []).length).toBe(2);
    expect(html).toContain("Close");
    expect(html).toContain("D+4");
    expect(html).toContain("today");
  });
});

describe("readout graphics", () => {
  it("hides the decorative meter from assistive tech but prints the numbers", () => {
    const html = renderToStaticMarkup(
      createElement(Meter, { name: "HSK 1", pct: 0.42, figure: "300/500" }),
    );
    expect(html).toContain("aria-hidden");
    expect(html).toContain("width:42%");
    expect(html).toContain("300/500");
  });

  it("labels a verdict with a word, not colour alone", () => {
    expect(renderToStaticMarkup(createElement(VerdictFlag, { verdict: "behind" }))).toContain("Behind");
    expect(renderToStaticMarkup(createElement(VerdictFlag, { verdict: "unknown" }))).toContain("No reading");
  });
});

/**
 * The chat log. Both assertions FAIL against the pre-fix component: the log was a plain <div> with
 * no live region (a reply arrived silently for a screen-reader user) and no tabindex (a capped
 * scroll box with no focusable descendant cannot be scrolled by keyboard at all — WCAG 2.1.1).
 */
describe("chat log", () => {
  const html = () => renderToStaticMarkup(createElement(Chat));

  it("is an announced, keyboard-reachable region from first render", () => {
    const out = html();
    expect(out).toMatch(/class="[^"]*chatLog[^"]*" tabindex="0" role="log" aria-live="polite"/);
    expect(out).toContain('aria-label="Conversation with Lucy"');
  });

  it("marks the hanzi in Lucy's greeting as Chinese but leaves the pinyin and English alone", () => {
    const out = html();
    expect(out).toContain('<span lang="zh-Hans">嗨</span> (hāi)!');
    expect(out).toContain('<span lang="zh-Hans">加油</span>');
    expect(out).not.toContain('lang="zh-Hans">Lucy');
  });
});

describe("markHanzi", () => {
  it("splits a mixed string into English text and marked Chinese runs", () => {
    expect(markHanzi("no chinese here")).toEqual(["no chinese here"]);
    // Alternating plain/marked parts; the odd ones are the elements.
    const parts = markHanzi("I said 你好 twice");
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe("I said ");
    expect(parts[2]).toBe(" twice");
  });

  it("keeps pinyin and tone marks out of the Chinese run", () => {
    const html = renderToStaticMarkup(
      createElement("p", null, markHanzi("跳舞 (tiàowǔ) means to dance")),
    );
    expect(html).toBe('<p><span lang="zh-Hans">跳舞</span> (tiàowǔ) means to dance</p>');
  });

  it("marks full-width punctuation with the run it belongs to", () => {
    const html = renderToStaticMarkup(createElement("p", null, markHanzi("加油！ Keep going")));
    expect(html).toBe('<p><span lang="zh-Hans">加油！</span> Keep going</p>');
  });
});
