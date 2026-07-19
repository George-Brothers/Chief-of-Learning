import { describe, it, expect } from "vitest";
import { contentHash } from "../agent/hash";

describe("contentHash", () => {
  it("is stable and content-sensitive", () => {
    expect(contentHash("hello")).toBe(contentHash("hello"));
    expect(contentHash("hello")).not.toBe(contentHash("world"));
    expect(contentHash("hello")).toMatch(/^[0-9a-f]{64}$/);
  });
});
