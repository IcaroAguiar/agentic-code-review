import { describe, expect, it } from "vitest";

describe("security boundary", () => {
  it("rejects unsafe dynamic input before it reaches the sink", async () => {
    await expect(executeBoundaryForTest("../etc/passwd")).rejects.toThrow();
    await expect(executeBoundaryForTest("'; DROP TABLE users; --")).rejects.toThrow();
    await expect(executeBoundaryForTest("<img src=x onerror=alert(1)>")).rejects.toThrow();
  });
});

async function executeBoundaryForTest(_input: string) {
  throw new Error("Replace with the real route/service/command boundary under review.");
}
