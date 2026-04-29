import { describe, expect, it } from "vitest";

describe("auth and authorization boundary", () => {
  it("rejects unauthenticated, wrong-role, and cross-tenant access", async () => {
    await expect(callProtectedBoundaryForTest({ session: null })).rejects.toThrow();
    await expect(callProtectedBoundaryForTest({ role: "viewer" })).rejects.toThrow();
    await expect(callProtectedBoundaryForTest({ tenantId: "other-tenant" })).rejects.toThrow();
  });
});

async function callProtectedBoundaryForTest(_context: unknown) {
  throw new Error("Replace with the real route/service/tool boundary under review.");
}
