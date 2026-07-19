export type PushResult = { ok: boolean; skipped?: boolean; lessonId?: string };

/**
 * A failed push. `retriable` separates the transient failures worth another attempt (the network
 * dropped, the cloud is redeploying, a 429) from the permanent ones (a wrong secret, a malformed
 * body) that would fail identically on every attempt — retrying those just delays the dead-letter.
 */
export class PushError extends Error {
  constructor(message: string, readonly retriable: boolean) {
    super(message);
    this.name = "PushError";
  }
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetriableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function pushOnce(
  cfg: { cloudUrl: string; secret: string },
  markdown: string, hash: string, date: string,
): Promise<PushResult> {
  let r: Response;
  try {
    r = await fetch(`${cfg.cloudUrl}/api/ingest/transcript`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.secret}` },
      body: JSON.stringify({ markdown, hash, date }),
    });
  } catch (e) {
    // fetch only throws on transport failure — exactly the blip worth retrying.
    throw new PushError(`pushTranscript network error: ${(e as Error).message}`, true);
  }
  if (!r.ok) {
    throw new PushError(`pushTranscript failed: ${r.status} ${await r.text()}`, isRetriableStatus(r.status));
  }
  return (await r.json()) as PushResult;
}

export type PushOpts = {
  attempts?: number;
  baseDelayMs?: number;
  /** Injectable for tests, so a retry suite doesn't actually sleep. */
  sleepFn?: (ms: number) => Promise<void>;
};

/**
 * Push a transcript, retrying transient failures with exponential backoff.
 *
 * Safe to call repeatedly: the cloud dedups on the content hash (`lessonExists`), so a retry — or a
 * dead-letter replay days later — can never create a duplicate lesson. Callers must still handle the
 * final throw; the watcher fires once per file, so a dropped push is a lost lesson (see agent/ingest.ts).
 */
export async function pushTranscript(
  cfg: { cloudUrl: string; secret: string },
  markdown: string, hash: string, date: string,
  opts: PushOpts = {},
): Promise<PushResult> {
  const attempts = Math.max(1, opts.attempts ?? 4);
  const base = opts.baseDelayMs ?? 1000;
  const wait = opts.sleepFn ?? sleep;
  for (let i = 0; ; i++) {
    try {
      return await pushOnce(cfg, markdown, hash, date);
    } catch (e) {
      const err = e as PushError;
      if (i >= attempts - 1 || !err.retriable) throw err;
      await wait(base * 2 ** i); // 1s, 2s, 4s
    }
  }
}
