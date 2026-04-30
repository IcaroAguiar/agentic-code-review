import { describe, expect, it } from "vitest";

/**
 * Template: exercise the real boundary with failing dependencies and assert
 * timeout/retry/circuit behavior plus safe logs/metrics/traces.
 */
describe("observability and resilience", () => {
  it("times out external calls and records safe operational context", async () => {
    const dependency = createFailingDependency({ mode: "timeout" });
    const telemetry = createTelemetryProbe();
    const service = createRealService({ dependency, telemetry });

    await expect(service.execute({ tenantId: "tenant-1", requestId: "req-1" })).rejects.toThrow(/timeout/i);

    expect(dependency.calls()).toBeLessThanOrEqual(3);
    expect(telemetry.logs()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          level: "error",
          requestId: "req-1",
          tenantId: "tenant-1",
        }),
      ])
    );
    expect(JSON.stringify(telemetry.logs())).not.toMatch(/password|token|secret/i);
    expect(telemetry.metrics()).toEqual(expect.arrayContaining([expect.objectContaining({ name: expect.stringMatching(/error|timeout/i) })]));
  });
});

function createFailingDependency(_input: { mode: "timeout" }): { calls(): number } {
  throw new Error("Replace with a dependency fake that exercises the real retry/timeout path.");
}

function createTelemetryProbe(): {
  logs(): Array<Record<string, unknown>>;
  metrics(): Array<Record<string, unknown>>;
} {
  throw new Error("Replace with the repository telemetry/logging test probe.");
}

function createRealService(_deps: { dependency: unknown; telemetry: unknown }): {
  execute(input: { tenantId: string; requestId: string }): Promise<unknown>;
} {
  throw new Error("Replace with the real service/use-case import.");
}
