import { describe, expect, it } from "vitest";

/**
 * Template: adapt the imports to your framework's real HTTP app/server.
 * The test should hit the production route/controller boundary, not a copied
 * handler body.
 */
describe("REST API contract", () => {
  it("uses resource-oriented path, method semantics, status code, and pagination", async () => {
    const response = await requestRealApp()
      .get("/v1/orders")
      .query({ page: 1, pageSize: 20, status: "open" });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      data: expect.any(Array),
      pagination: {
        page: 1,
        pageSize: 20,
      },
    });
  });

  it("rejects mutating behavior through safe methods", async () => {
    const response = await requestRealApp().get("/v1/orders/123/delete");

    expect([404, 405]).toContain(response.status);
  });
});

function requestRealApp(): {
  get(path: string): {
    query(input: Record<string, unknown>): Promise<{ status: number; body: unknown }>;
  };
} {
  throw new Error("Replace with the repository-native supertest/app.inject/client setup.");
}
