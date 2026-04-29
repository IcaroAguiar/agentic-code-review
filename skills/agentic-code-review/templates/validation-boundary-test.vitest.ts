import { describe, expect, it } from "vitest";

describe("validation boundary regression", () => {
  it("rejects invalid input at the public boundary", async () => {
    const invalidInput = {};
    const callBoundary = async (_input: unknown) => {
      throw new Error("Replace with the real controller, route handler, command, parser, or schema boundary.");
    };

    await expect(callBoundary(invalidInput)).rejects.toThrow();
  });
});
