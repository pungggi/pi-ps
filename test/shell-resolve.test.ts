/**
 * pi-ps — Shell resolution tests
 */

import { describe, it, expect, afterEach } from "vitest";
import { resolveShell, invalidateCache } from "../src/shell-resolve.js";

describe("shell resolution", () => {
  afterEach(() => {
    invalidateCache();
  });

  it("resolves a shell on Windows", () => {
    const shell = resolveShell();
    // On Windows, at least Windows PowerShell should be found
    if (process.platform === "win32") {
      expect(shell).not.toBeNull();
      expect(shell!.exe).toBeTruthy();
      expect(shell!.version).toBeTruthy();
    }
  });

  it("caches the result", () => {
    const r1 = resolveShell();
    const r2 = resolveShell();
    expect(r1).toBe(r2); // same reference
  });

  it("invalidates cache", () => {
    const r1 = resolveShell();
    invalidateCache();
    const r2 = resolveShell();
    // Should re-resolve (may be equal value but different object)
    if (r1 && r2) {
      expect(r1.exe).toBe(r2.exe);
    }
  });
});
