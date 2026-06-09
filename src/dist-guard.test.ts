// dist-guard.test.ts — standalone dist secret/zod guard for @usepulseapp/sdk-web.
//
// Ported from block D of the Pulse ingestion server
// This gives the standalone web SDK repo its own dist integrity check without
// depending on anything in the Pulse server
//
// Reads ../dist/index.js and ../dist/index.cjs (relative to this file) and asserts:
//   (1) No zod identifiers in the bundle (SDK runtime is zod-free).
//   (2) No ingestKey / secret-key material in the bundle.
//
// Run: pnpm --filter @usepulseapp/sdk-web test
// Requires: pnpm --filter @usepulseapp/sdk-web build (produces dist/)
//
// NOTE: uses fileURLToPath(import.meta.url) rather than new URL(".", ...).pathname
// because vitest's jsdom environment patches URL resolution in a way that breaks
// the .pathname approach for filesystem access.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const distDir = join(__dirname, "../dist");

function readDist(filename: string): string {
  const path = join(distDir, filename);
  try {
    return readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `dist/${filename} not found — run 'pnpm --filter @usepulseapp/sdk-web build' first. Original error: ${String(err)}`,
    );
  }
}

describe("D) Build output — zod-free, no secrets in dist bundle", () => {
  it("dist/index.js exists (ESM bundle)", () => {
    expect(() => readDist("index.js")).not.toThrow();
  });

  it("dist/index.cjs exists (CJS bundle)", () => {
    expect(() => readDist("index.cjs")).not.toThrow();
  });

  it("dist/index.js does NOT contain 'zod' (zod-free runtime)", () => {
    const content = readDist("index.js");
    expect(content).not.toContain("ZodError");
    expect(content).not.toContain("ZodType");
    const zodModuleRefs = content.match(/require\(['"]zod['"]\)|from ['"]zod['"]/g);
    expect(zodModuleRefs).toBeNull();
  });

  it("dist/index.cjs does NOT contain 'zod' (zod-free runtime)", () => {
    const content = readDist("index.cjs");
    expect(content).not.toContain("ZodError");
    expect(content).not.toContain("ZodType");
    const zodModuleRefs = content.match(/require\(['"]zod['"]\)|from ['"]zod['"]/g);
    expect(zodModuleRefs).toBeNull();
  });

  it("dist/index.js does NOT contain 'ingestKey' or secret-key material", () => {
    const content = readDist("index.js");
    expect(content).not.toContain("ingestKey");
    const secretKeyPattern = /sk_[A-Za-z0-9_-]{8,}/g;
    expect(secretKeyPattern.test(content)).toBe(false);
  });

  it("dist/index.cjs does NOT contain 'ingestKey' or secret-key material", () => {
    const content = readDist("index.cjs");
    expect(content).not.toContain("ingestKey");
    const secretKeyPattern = /sk_[A-Za-z0-9_-]{8,}/g;
    expect(secretKeyPattern.test(content)).toBe(false);
  });
});
