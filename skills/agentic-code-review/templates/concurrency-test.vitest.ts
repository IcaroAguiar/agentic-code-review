import { describe, expect, it, vi } from "vitest";

describe("concurrency regression", () => {
  it("keeps the operation consistent under parallel calls", async () => {
    const operation = async () => {
      throw new Error("Replace with the real production function, handler, service, or repository call.");
    };

    const calls = Array.from({ length: 10 }, () => operation());
    const results = await Promise.allSettled(calls);

    expect(results).toHaveLength(10);
    expect(vi.isMockFunction(operation)).toBe(false);
    // Assert the invariant that matters: one row created, no duplicates, stable balance,
    // idempotent response, or expected conflict handling.
  });
});
