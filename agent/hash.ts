import { createHash } from "node:crypto";

export function contentHash(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}
