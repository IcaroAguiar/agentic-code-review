import { describe, expect, it } from "vitest";

describe("idempotency regression", () => {
  it("does not duplicate side effects when the same operation is repeated", async () => {
    const input = { idempotencyKey: "test-key" };
    const operation = async (_value: typeof input) => {
      throw new Error("Replace with the real production entrypoint.");
    };

    await operation(input);
    await operation(input);

    // Assert the invariant: one record, one emitted event, stable status, or same response.
    expect(true).toBe(false);
  });
});
