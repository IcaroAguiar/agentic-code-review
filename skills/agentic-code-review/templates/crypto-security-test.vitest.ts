import { describe, expect, it } from "vitest";

describe("crypto security", () => {
  it("uses salted adaptive password hashing and rejects legacy hashes", async () => {
    const hash = await hashPasswordForTest("correct horse battery staple");

    expect(hash).not.toMatch(/^(md5|sha1):/i);
    expect(await verifyPasswordForTest("correct horse battery staple", hash)).toBe(true);
    expect(await verifyPasswordForTest("wrong password", hash)).toBe(false);
  });
});

async function hashPasswordForTest(_password: string) {
  throw new Error("Replace with the real password hashing function under review.");
}

async function verifyPasswordForTest(_password: string, _hash: string) {
  throw new Error("Replace with the real password verification function under review.");
}
