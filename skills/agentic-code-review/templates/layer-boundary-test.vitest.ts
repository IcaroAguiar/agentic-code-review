import { describe, expect, it } from "vitest";

/**
 * Template: prove the public application boundary still owns orchestration.
 * Domain code should remain framework-free and persistence should stay behind a
 * port/repository adapter.
 */
describe("architecture layer boundary", () => {
  it("executes behavior through the application boundary with a port fake", async () => {
    const repository = createRepositoryPortFake();
    const useCase = createRealUseCase({ repository });

    const result = await useCase.execute({ id: "order-1" });

    expect(result).toMatchObject({ id: "order-1" });
    expect(repository.calls()).toEqual(["findById:order-1"]);
  });
});

function createRepositoryPortFake(): { calls(): string[] } {
  throw new Error("Replace with a fake that implements the production port/interface.");
}

function createRealUseCase(_deps: { repository: unknown }): {
  execute(input: { id: string }): Promise<unknown>;
} {
  throw new Error("Replace with the real application service/use-case import.");
}
