import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const PLATFORM_FREE = ["src/matching.ts", "src/types.ts", "src/config.ts", "src/cursor-api.ts", "src/url.ts"];

describe("platform-free planner modules", () => {
  it("do not import AWS or Cloudflare runtimes", () => {
    for (const file of PLATFORM_FREE) {
      const source = readFileSync(file, "utf8");
      expect(source).not.toMatch(/@aws-sdk|aws-sdk|cloudflare:|@cloudflare/);
    }
  });
});
