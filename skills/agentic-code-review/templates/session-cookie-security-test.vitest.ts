import { describe, expect, it } from "vitest";

describe("session cookie security", () => {
  it("sets secure browser cookie attributes", async () => {
    const cookie = await issueSessionCookieForTest();

    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    expect(cookie).toMatch(/SameSite=(Lax|Strict|None)/);
  });
});

async function issueSessionCookieForTest() {
  throw new Error("Replace with the real login/session boundary under review.");
}
