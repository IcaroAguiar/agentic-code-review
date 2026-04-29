import { describe, expect, it, vi } from "vitest";

describe("N+1 query regression", () => {
  it("uses bounded query count as item count grows", async () => {
    const querySpy = vi.fn();
    const smallInput = Array.from({ length: 2 }, (_, index) => ({ id: `small-${index}` }));
    const largeInput = Array.from({ length: 25 }, (_, index) => ({ id: `large-${index}` }));

    const runProductionPath = async (_items: Array<{ id: string }>) => {
      throw new Error("Replace with the real production path and instrument the repository/client query methods.");
    };

    await runProductionPath(smallInput);
    const smallQueryCount = querySpy.mock.calls.length;
    expect(smallQueryCount).toBeGreaterThan(0);

    querySpy.mockClear();
    await runProductionPath(largeInput);
    const largeQueryCount = querySpy.mock.calls.length;
    expect(largeQueryCount).toBeGreaterThan(0);

    expect(largeQueryCount).toBeLessThanOrEqual(smallQueryCount + 2);
  });
});
