const TS = /^\d{2}:\d{2}:\d{2}[.,]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}[.,]\d{3}/;
const CUE_NUM = /^\d+$/;

/** The extensions toMarkdown actually understands. Everything else (a stray note, an .mp3/.m4a
 *  sidecar dropped next to a transcript) would otherwise be pushed as a bogus lesson. */
const TRANSCRIPT_EXTS = new Set([".vtt", ".srt", ".txt", ".md"]);

export function isTranscript(path: string): boolean {
  const dot = path.lastIndexOf(".");
  return dot >= 0 && TRANSCRIPT_EXTS.has(path.slice(dot).toLowerCase());
}

export function toMarkdown(filename: string, raw: string): string {
  const ext = filename.slice(filename.lastIndexOf(".")).toLowerCase();
  if (ext === ".vtt" || ext === ".srt") {
    return raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && l !== "WEBVTT" && !TS.test(l) && !CUE_NUM.test(l))
      .join("\n");
  }
  return raw.trim();
}
