// R2 / P0-2: the file watcher fires exactly once per transcript. If a push fails and we only log it,
// the lesson is gone — the file stays on disk but is never re-emitted, so there's no card, no lesson
// row, and no warning anywhere the owner looks. A push that exhausts its retries parks here instead.
import { mkdir, readdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { contentHash } from "./hash";

/**
 * A transcript that couldn't reach the cloud, held on disk so the sweep can replay it.
 *
 * Two shapes: a *content* park (`markdown` + `hash` present) for a push that failed after the file
 * was read, replayed verbatim; and a *source* park (`markdown`/`hash` absent) for a transcript that
 * couldn't even be read (EBUSY/EPERM on a WSL/Windows mount) — the sweep re-reads `source` before it
 * pushes, so a transient read error costs no lesson either.
 */
export type ParkedPush = {
  markdown?: string;
  hash?: string;
  /** The lesson's date, captured when it was watched — a replay days later must not re-date it. */
  date: string;
  /** The transcript file this came from: traced back by the owner, and re-read for a source park. */
  source: string;
};

const SUFFIX = ".push.json";

/**
 * Park a failed transcript. Keyed so the same transcript failing twice parks once: by content hash
 * for a content park, and by a hash of the source path for a read-failure park (no content to hash).
 */
export async function park(dir: string, p: ParkedPush): Promise<string> {
  await mkdir(dir, { recursive: true });
  const key = p.hash ? p.hash.slice(0, 12) : `src-${contentHash(p.source).slice(0, 12)}`;
  const file = join(dir, `${p.date}-${key}${SUFFIX}`);
  await writeFile(file, JSON.stringify(p, null, 2), "utf8");
  return file;
}

/** Every parked push. A missing dir means nothing has ever failed; any other error is real. */
export async function listParked(dir: string): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  return names.filter((n) => n.endsWith(SUFFIX)).sort().map((n) => join(dir, n));
}

/** Read a parked push back, or null if the file is unreadable/corrupt (kept for the owner to inspect). */
export async function readParked(file: string): Promise<ParkedPush | null> {
  try {
    const p = JSON.parse(await readFile(file, "utf8")) as ParkedPush;
    // A content park needs markdown+hash together; a source park needs neither. Anything else is corrupt.
    const valid = p?.date && p?.source && (p.markdown ? Boolean(p.hash) : !p.hash);
    return valid ? p : null;
  } catch {
    return null;
  }
}

/** Drop a parked push, once the cloud has accepted it. */
export async function unpark(file: string): Promise<void> {
  await unlink(file);
}
