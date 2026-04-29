import { describe, expect, it } from "vitest";

/**
 * Template: compare the generated/runtime OpenAPI document against the public
 * route behavior changed in the PR. Keep this test at the producer boundary.
 */
describe("OpenAPI compatibility", () => {
  it("documents changed route method, status, pagination, and error response", async () => {
    const openapi = await loadGeneratedOpenApiDocument();
    const operation = openapi.paths?.["/v1/orders"]?.get;

    expect(operation).toBeDefined();
    expect(operation.parameters).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "page", in: "query" }),
        expect.objectContaining({ name: "pageSize", in: "query" }),
      ])
    );
    expect(operation.responses).toMatchObject({
      200: expect.any(Object),
      400: expect.any(Object),
    });
  });
});

async function loadGeneratedOpenApiDocument(): Promise<{
  paths?: Record<string, Record<string, { parameters?: unknown[]; responses?: Record<string, unknown> }>>;
}> {
  throw new Error("Replace with the repository-native OpenAPI generator or checked-in schema import.");
}
