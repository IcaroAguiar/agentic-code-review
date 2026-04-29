import { describe, expect, it, vi } from "vitest";

describe("transaction rollback regression", () => {
  it("does not persist partial state when a later step fails", async () => {
    const failingDependency = vi.fn().mockRejectedValue(new Error("forced failure"));
    const operation = async () => {
      throw new Error("Replace with the real production entrypoint and inject the failing boundary dependency.");
    };

    await expect(operation()).rejects.toThrow("forced failure");
    expect(failingDependency).toHaveBeenCalled();
    // Assert the durable state was rolled back or compensated.
  });
});
