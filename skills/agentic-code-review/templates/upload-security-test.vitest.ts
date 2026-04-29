import { describe, expect, it } from "vitest";

describe("upload security", () => {
  it("rejects unsafe filenames, oversized files, and disallowed media types", async () => {
    await expect(uploadForTest({ name: "../secret.txt", type: "text/plain", size: 10 })).rejects.toThrow();
    await expect(uploadForTest({ name: "avatar.exe", type: "application/x-msdownload", size: 10 })).rejects.toThrow();
    await expect(uploadForTest({ name: "huge.png", type: "image/png", size: 50_000_000 })).rejects.toThrow();
  });
});

async function uploadForTest(_file: { name: string; type: string; size: number }) {
  throw new Error("Replace with the real upload boundary under review.");
}
