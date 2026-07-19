import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * The palette's contrast, computed from the stylesheet itself rather than trusted from its comment.
 *
 * The header of dashboard.module.css used to claim the palette met 4.5:1; --muted actually sat at
 * 3.55:1 on the dark panels and 4.09:1 on light, and every single one of its usages is small text
 * (.empty 12px, .tags/.logDate/.loginCard p 11.5px, .msgMeta/.asgKind 10.5px, blockquote, and the
 * struck-through text of a completed task). This test FAILS against those old values.
 *
 * Only tokens that carry text are checked. --rule/--rule-2 are hairlines and the two aria-hidden
 * separator glyphs; --live-dim is a border; meter fills are aria-hidden graphics whose figures are
 * printed beside them. Those owe 3:1 at most and are deliberately excluded.
 */

const CSS = readFileSync(fileURLToPath(new URL("../app/dashboard/dashboard.module.css", import.meta.url)), "utf8");

/** The `.root` block is the dark theme; the one inside the light media query overrides it. */
function tokens(): { dark: Record<string, string>; light: Record<string, string> } {
  const lightStart = CSS.indexOf("@media (prefers-color-scheme: light)");
  expect(lightStart).toBeGreaterThan(0);
  const grab = (src: string) => {
    const out: Record<string, string> = {};
    for (const m of src.matchAll(/--([a-z0-9-]+):\s*(#[0-9a-f]{3,8})\s*;/gi)) out[m[1]] = m[2];
    return out;
  };
  const dark = grab(CSS.slice(0, lightStart));
  return { dark, light: { ...dark, ...grab(CSS.slice(lightStart, CSS.indexOf("@media (prefers-reduced-motion"))) } };
}

function relativeLuminance(hex: string): number {
  const h = hex.replace("#", "");
  const full = h.length === 3 ? [...h].map((c) => c + c).join("") : h;
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(full.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 2.x contrast ratio, 1..21. */
function contrast(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

it("computes known WCAG ratios (sanity check on the maths itself)", () => {
  expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5);
  expect(contrast("#ffffff", "#ffffff")).toBeCloseTo(1, 5);
  expect(contrast("#767676", "#ffffff")).toBeCloseTo(4.54, 1); // the classic AA-on-white grey
});

const TEXT_TOKENS = ["ink", "ink-2", "muted", "live", "alarm", "amber"];
const SURFACES = ["plane", "panel", "panel-hot"];

describe.each(["dark", "light"] as const)("%s palette", (theme) => {
  const palette = tokens()[theme];

  it("defines every token it is supposed to", () => {
    for (const t of [...TEXT_TOKENS, ...SURFACES]) expect(palette[t], `--${t}`).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it.each(TEXT_TOKENS)("--%s clears 4.5:1 on every surface it can land on", (token) => {
    for (const surface of SURFACES) {
      const ratio = contrast(palette[token], palette[surface]);
      expect(ratio, `--${token} on --${surface} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("keeps the three-step ink hierarchy visible rather than flattening the palette", () => {
    // Fixing contrast by making everything the same colour would pass the check above and destroy
    // the design, so the dimmest text must stay measurably dimmer than the next step up.
    const on = (t: string) => contrast(palette[t], palette.plane);
    expect(on("ink")).toBeGreaterThan(on("ink-2") * 1.5);
    expect(on("ink-2")).toBeGreaterThan(on("muted") * 1.2);
  });

  it("keeps the meter and flag graphics above the 3:1 non-text threshold", () => {
    expect(contrast(palette.live, palette.plane)).toBeGreaterThanOrEqual(3);
    expect(contrast(palette["rule-2"], palette.plane)).toBeLessThan(3); // hairline, by design
  });
});
