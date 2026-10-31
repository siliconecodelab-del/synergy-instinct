import { describe, it, expect } from "vitest";
import { canNudge } from "../src/nudge-gate.js";

describe("nudge-gate", () => {
  it("blocks quiet hours", () => {
    const d = new Date("2026-10-30T23:00:00");
    expect(canNudge(d, null).allowed).toBe(false);
  });
  it("blocks same day", () => {
    const d = new Date("2026-10-30T10:00:00");
    const last = new Date("2026-10-30T09:00:00").toISOString();
    expect(canNudge(d, last).allowed).toBe(false);
  });
  it("allows new day", () => {
    const d = new Date("2026-10-31T10:00:00");
    const last = new Date("2026-10-30T09:00:00").toISOString();
    expect(canNudge(d, last).allowed).toBe(true);
  });
});