import type { ReactNode } from "react";
import styles from "./dashboard.module.css";

/**
 * A small Markdown renderer for the Notion-authored docs the dashboard shows (Study Map, Knowledge
 * Ledger, homework, lesson summaries). Those pages are written by Lucy in a narrow subset —
 * headings, bullets, numbers, bold, inline code, the odd link — so a ~150-line parser covers them.
 *
 * Why not a dependency: react-markdown pulls remark + micromark + ~40 transitive packages onto a
 * deployment that ships no other client-side markdown, and would still need a sanitizer bolted on.
 *
 * XSS: the parser emits an AST of plain data and the renderer turns it into React elements, so every
 * string lands in a React text node and is escaped by React. There is no dangerouslySetInnerHTML
 * anywhere in this file, raw HTML in the source is shown as literal text, and link hrefs are limited
 * to http/https/mailto (a `javascript:` URL renders as plain text instead of a link).
 */

// ---- AST --------------------------------------------------------------------

export type Inline =
  | { t: "text"; v: string }
  | { t: "strong"; c: Inline[] }
  | { t: "em"; c: Inline[] }
  | { t: "code"; v: string }
  | { t: "link"; href: string; c: Inline[] };

export type Block =
  | { t: "h"; level: 1 | 2 | 3; c: Inline[] }
  | { t: "p"; c: Inline[] }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] }
  | { t: "quote"; c: Inline[] }
  | { t: "pre"; v: string }
  | { t: "hr" };

// ---- Inline -----------------------------------------------------------------

// One alternation, tried left to right, so `**a**` wins over `*a*`. Emphasis spans must start and
// end on a non-space character, which is what stops a lone `*` or a bullet from opening one.
const INLINE_RE =
  /(\*\*|__)(?=\S)([\s\S]*?\S)\1|\*(?=\S)([^*\n]*\S)\*|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)/;

/**
 * Origin used only to resolve a candidate href so we can ask "does this stay on our own site?".
 * It never appears in the output; `.invalid` is reserved by RFC 2606 so it can never be a real host.
 */
const RESOLVE_BASE = "https://markdown.invalid/";
const RESOLVE_ORIGIN = "https://markdown.invalid";

/**
 * Control characters, soft hyphen, zero-width and bidi-override characters: the parser either
 * percent-encodes them or the font hides them, so they let the visible link text and the real
 * target disagree. Nothing Lucy writes needs one.
 */
const INVISIBLE = /[\u0000-\u001f\u007f-\u009f\u00ad\u200b-\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069\ufeff]/;

/**
 * Only web-navigable schemes become links; anything else (javascript:, data:) stays plain text, and
 * a relative href must still be same-origin once *resolved*.
 *
 * Pattern-matching the raw string does not work, because the WHATWG parser rewrites it before the
 * browser navigates: for http/https a backslash is a slash, so `/\evil.com` and `\/evil.com` both
 * resolve to `https://evil.com` while passing a `startsWith("//")` check; tab/CR/LF are deleted from
 * anywhere in the URL, so `java<TAB>script:` is a javascript: URL; and leading C0 bytes are trimmed
 * before the scheme is read. So: strip exactly what the parser strips, resolve the result against a
 * fixed base, and judge the *resolved* URL. What we return is the cleaned string, which the browser
 * will resolve identically to the one we validated.
 */
export function safeHref(raw: string): string | null {
  const href = raw.replace(/[\t\n\r]/g, "").replace(/^[\u0000-\u0020]+|[\u0000-\u0020]+$/g, "");
  if (!href) return null;
  // Remaining control characters get percent-encoded rather than rejected by the parser, which can
  // make the rendered link text and the real target disagree. Nothing legitimate here needs them.
  if (INVISIBLE.test(href)) return null;

  let url: URL;
  try {
    url = new URL(href, RESOLVE_BASE);
  } catch {
    return null;
  }
  if (url.protocol === "mailto:") return href;
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // An explicitly absolute web link is allowed (it renders with rel="noopener noreferrer"); anything
  // else was written as a path and must still land on this origin after the parser has had its way.
  if (/^https?:\/\//i.test(href)) return href;
  return url.origin === RESOLVE_ORIGIN ? href : null;
}

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  const pushText = (v: string) => {
    if (!v) return;
    const last = out[out.length - 1];
    if (last?.t === "text") last.v += v;
    else out.push({ t: "text", v });
  };

  while (rest) {
    const m = INLINE_RE.exec(rest);
    if (!m) {
      pushText(rest);
      break;
    }
    pushText(rest.slice(0, m.index));
    if (m[2] !== undefined) out.push({ t: "strong", c: parseInline(m[2]) });
    else if (m[3] !== undefined) out.push({ t: "em", c: parseInline(m[3]) });
    else if (m[4] !== undefined) out.push({ t: "code", v: m[4] });
    else {
      const href = safeHref(m[6]);
      const label = m[5];
      if (href) out.push({ t: "link", href, c: parseInline(label) });
      else pushText(`${label} (${m[6]})`); // keep the URL visible rather than silently dropping it
    }
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

// ---- Blocks -----------------------------------------------------------------

const HEADING_RE = /^(#{1,6})\s+(.*)$/;
const BULLET_RE = /^\s*[-*•·]\s+(.*)$/;
const ORDERED_RE = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE_RE = /^\s*>\s?(.*)$/;
const HR_RE = /^\s*(?:[-*_]\s*){3,}$/;
const FENCE_RE = /^\s*```/;

export function parseMarkdown(src: string): Block[] {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  const flushParagraph = (buf: string[]) => {
    if (buf.length) blocks.push({ t: "p", c: parseInline(buf.join(" ").trim()) });
    buf.length = 0;
  };
  const para: string[] = [];

  while (i < lines.length) {
    const line = lines[i];

    if (!line.trim()) {
      flushParagraph(para);
      i++;
      continue;
    }

    if (FENCE_RE.test(line)) {
      flushParagraph(para);
      const body: string[] = [];
      i++;
      while (i < lines.length && !FENCE_RE.test(lines[i])) body.push(lines[i++]);
      i++; // closing fence (or EOF)
      blocks.push({ t: "pre", v: body.join("\n") });
      continue;
    }

    if (HR_RE.test(line)) {
      flushParagraph(para);
      blocks.push({ t: "hr" });
      i++;
      continue;
    }

    const h = HEADING_RE.exec(line);
    if (h) {
      flushParagraph(para);
      // Notion docs go up to ####; anything deeper renders at the smallest heading rank.
      const level = Math.min(3, h[1].length) as 1 | 2 | 3;
      blocks.push({ t: "h", level, c: parseInline(h[2].trim()) });
      i++;
      continue;
    }

    if (BULLET_RE.test(line) || ORDERED_RE.test(line)) {
      flushParagraph(para);
      const ordered = !BULLET_RE.test(line) && ORDERED_RE.test(line);
      const re = ordered ? ORDERED_RE : BULLET_RE;
      const items: Inline[][] = [];
      // Nested bullets are flattened into one level: these docs are shallow, and a wrong-looking
      // indent from a model is more common than a genuine sub-list.
      while (i < lines.length && re.test(lines[i])) {
        items.push(parseInline(re.exec(lines[i])![1].trim()));
        i++;
      }
      blocks.push(ordered ? { t: "ol", items } : { t: "ul", items });
      continue;
    }

    const q = QUOTE_RE.exec(line);
    if (q) {
      flushParagraph(para);
      const body: string[] = [q[1]];
      i++;
      while (i < lines.length && QUOTE_RE.test(lines[i])) body.push(QUOTE_RE.exec(lines[i++])![1]);
      blocks.push({ t: "quote", c: parseInline(body.join(" ").trim()) });
      continue;
    }

    para.push(line.trim());
    i++;
  }
  flushParagraph(para);
  return blocks;
}

// ---- Render -----------------------------------------------------------------

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, k) => {
    switch (n.t) {
      // A bare string needs no key — React only requires them for elements.
      case "text":
        return n.v;
      case "strong":
        return <strong key={k}>{renderInline(n.c)}</strong>;
      case "em":
        return <em key={k}>{renderInline(n.c)}</em>;
      case "code":
        return <code key={k}>{n.v}</code>;
      case "link":
        return (
          <a key={k} href={n.href} target="_blank" rel="noopener noreferrer">
            {renderInline(n.c)}
          </a>
        );
    }
  });
}

/** Render Notion Markdown as real formatted output. `source` is untrusted text; see the file note. */
/**
 * `label` marks this rendering as a scrollable region: the docs shown in the Map grid are capped at
 * a fixed height by `.docGrid .md`, and a rendered doc contains no focusable element, so without a
 * tabindex on the container a keyboard user cannot scroll it at all (WCAG 2.1.1) — the text below
 * the fold is simply unreachable. A labelled `role="region"` also gives the Tab stop a name, so
 * landing on it announces "Study map, region" rather than a silent group.
 */
export function Markdown({
  source,
  className,
  label,
}: {
  source: string;
  className?: string;
  label?: string;
}) {
  const blocks = parseMarkdown(source);
  return (
    <div
      className={className ? `${styles.md} ${className}` : styles.md}
      {...(label ? { tabIndex: 0, role: "region", "aria-label": label } : {})}
    >
      {blocks.map((b, k) => {
        switch (b.t) {
          case "h":
            if (b.level === 1) return <h3 key={k} className={styles.mdH1}>{renderInline(b.c)}</h3>;
            if (b.level === 2) return <h4 key={k} className={styles.mdH2}>{renderInline(b.c)}</h4>;
            return <h5 key={k} className={styles.mdH3}>{renderInline(b.c)}</h5>;
          case "p":
            return <p key={k}>{renderInline(b.c)}</p>;
          case "ul":
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={k}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it)}</li>
                ))}
              </ol>
            );
          case "quote":
            return <blockquote key={k}>{renderInline(b.c)}</blockquote>;
          case "pre":
            return <pre key={k}>{b.v}</pre>;
          case "hr":
            return <hr key={k} />;
        }
      })}
    </div>
  );
}
