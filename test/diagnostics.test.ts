/**
 * pi-ps — Diagnostics tests
 */

import { describe, it, expect } from "vitest";
import { runDoctor, formatDoctor } from "../src/diagnostics.js";
import { resolveShell } from "../src/shell-resolve.js";

describe("diagnostics", () => {
  it("runDoctor returns structured result", () => {
    const shell = resolveShell();
    const result = runDoctor(shell);

    expect(result).toHaveProperty("executionPolicy");
    expect(result).toHaveProperty("translateMode");
    expect(result).toHaveProperty("warnings");
    expect(Array.isArray(result.warnings)).toBe(true);
  });

  it("formatDoctor produces readable output", () => {
    const shell = resolveShell();
    const result = runDoctor(shell);
    const output = formatDoctor(result);

    expect(output).toContain("pi-ps doctor");
    expect(output).toContain("Shell:");
    expect(output).toContain("Exec Policy:");
  });

  it("formatDoctor handles no shell gracefully", () => {
    const result = runDoctor(null);
    const output = formatDoctor(result);

    expect(output).toContain("NOT FOUND");
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
