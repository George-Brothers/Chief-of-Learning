import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");

/**
 * The app shell — the two things that live outside every component and so have no other test.
 *
 * Both assertions FAIL against the pre-fix tree: there was no app/globals.css at all, and
 * app/layout.tsx imported no stylesheet, so the dark dashboard was painted on a DIV inside an 8px
 * white UA body margin, with a white gutter and a light scrollbar (`color-scheme` was declared on
 * `.root`, a div, where it never reaches the canvas).
 */
describe("global stylesheet", () => {
  const css = read("../app/globals.css");
  const layout = read("../app/layout.tsx");

  it("is imported by the root layout", () => {
    expect(layout).toMatch(/import\s+["']\.\/globals\.css["']/);
  });

  it("kills the UA body margin", () => {
    expect(css).toMatch(/body\s*\{[^}]*margin:\s*0/);
  });

  it("puts color-scheme and the canvas colour on :root, in both themes", () => {
    expect(css).toMatch(/:root\s*\{[^}]*color-scheme:\s*dark/);
    expect(css).toMatch(/:root\s*\{[^}]*background-color:\s*#0b0d0c/);
    const light = css.slice(css.indexOf("@media (prefers-color-scheme: light)"));
    expect(light).toMatch(/color-scheme:\s*light/);
    expect(light).toMatch(/background-color:\s*#eeede7/);
  });

  it("stays a reset and does not grow into a framework", () => {
    // Guard rail, not ceremony: this file is global and unscoped, so anything visual added here
    // leaks into every page. ~15 declarations is already generous for what it must do.
    const declarations = css.replace(/\/\*[\s\S]*?\*\//g, "").match(/[a-z-]+\s*:/g) ?? [];
    expect(declarations.length).toBeLessThan(15);
  });

  it("matches the canvas colours to the dashboard's --plane in each theme", () => {
    // globals.css cannot read a CSS-module custom property, so the two are duplicated by hand and
    // will drift silently unless something checks. This is that something.
    const module = read("../app/dashboard/dashboard.module.css");
    const planes = [...module.matchAll(/--plane:\s*(#[0-9a-f]{6})/gi)].map((m) => m[1].toLowerCase());
    expect(planes).toHaveLength(2); // dark, then light
    for (const plane of planes) expect(css.toLowerCase()).toContain(plane);
  });
});

describe("document language", () => {
  it("keeps the document English and marks Chinese per-run instead", () => {
    expect(read("../app/layout.tsx")).toContain('<html lang="en">');
    // The callsign is hanzi inside an English heading — the case that made this necessary.
    expect(read("../app/dashboard/page.tsx")).toContain('<em lang="zh-Hans">学习中文</em>');
    expect(read("../app/login/page.tsx")).toContain('<em lang="zh-Hans">学习中文</em>');
  });
});
