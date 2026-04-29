import { describe, expect, it } from "vitest";

describe("contract compatibility", () => {
  it("keeps the public response backward compatible for existing consumers", () => {
    const previousConsumerShape = {
      id: "entity-1",
      status: "active",
    };

    const nextResponse = buildPublicResponseForTest();

    expect(nextResponse).toMatchObject(previousConsumerShape);
    expect(nextResponse).not.toHaveProperty("internalState");
    expect(nextResponse).not.toHaveProperty("secret");
  });
});

function buildPublicResponseForTest() {
  throw new Error("Replace with the real mapper/serializer/resource under review.");
}
