import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Scratchpad } from "../src/scratchpad.js";
import { StateDir } from "@open-instinct/core";

function tempState(): StateDir {
  const root = mkdtempSync(join(tmpdir(), "agentrun-scratchpad-"));
  return new StateDir(root);
}

function cleanup(state: StateDir): void {
  rmSync(state.root, { recursive: true, force: true });
}

describe("Scratchpad", () => {
  afterEach(() => {
    // no-op; each test gets a fresh temp dir
  });

  it("claim returns fresh=true when no result exists yet", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      const claim = sp.claim("workflow:step:1");
      expect(claim.ok).toBe(true);
      expect(claim.fresh).toBe(true);
      expect("result" in claim).toBe(false);
    } finally {
      cleanup(state);
    }
  });

  it("claim returns fresh=false with cached result when one exists", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      sp.record("workflow:step:2", { output: "done" });
      const claim = sp.claim("workflow:step:2");
      expect(claim.ok).toBe(true);
      expect(claim.fresh).toBe(false);
      if (claim.fresh) throw new Error("should not be fresh");
      expect(claim.result).toEqual({ output: "done" });
    } finally {
      cleanup(state);
    }
  });

  it("lookup returns undefined for a missing key", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      expect(sp.lookup("missing")).toBeUndefined();
    } finally {
      cleanup(state);
    }
  });

  it("lookup returns the recorded result", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      sp.record("workflow:step:3", { value: 42 });
      expect(sp.lookup("workflow:step:3")).toEqual({ value: 42 });
    } finally {
      cleanup(state);
    }
  });

  it("record overwrites an existing entry", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      sp.record("workflow:step:4", { first: true });
      sp.record("workflow:step:4", { second: true });
      expect(sp.lookup("workflow:step:4")).toEqual({ second: true });
    } finally {
      cleanup(state);
    }
  });

  it("clear removes an entry and returns true", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      sp.record("workflow:step:5", { x: 1 });
      expect(sp.clear("workflow:step:5")).toBe(true);
      expect(sp.lookup("workflow:step:5")).toBeUndefined();
      expect(sp.clear("workflow:step:5")).toBe(false);
    } finally {
      cleanup(state);
    }
  });

  it("list returns all recorded keys", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      sp.record("key:b", { n: 2 });
      sp.record("key:a", { n: 1 });
      sp.record("key:c", { n: 3 });
      const keys = sp.list();
      expect(keys).toHaveLength(3);
      expect(keys.sort()).toEqual(["key:a", "key:b", "key:c"]);
    } finally {
      cleanup(state);
    }
  });

  it("treats a corrupt entry file as unclaimed (fresh=true)", () => {
    const state = tempState();
    try {
      const sp = new Scratchpad(state);
      const fs = require("node:fs");
      // Write a corrupt JSON file directly into the scratchpad dir using the sha256 of the key.
      const { createHash } = require("node:crypto");
      const fileName = createHash("sha256").update("corrupt-key").digest("hex") + ".json";
      fs.writeFileSync(join(state.root, "agentrun", "scratchpad", fileName), "{not valid json", "utf8");
      const claim = sp.claim("corrupt-key");
      expect(claim.ok).toBe(true);
      expect(claim.fresh).toBe(true);
    } finally {
      cleanup(state);
    }
  });

  it("scratchpad is isolated per state dir", () => {
    const a = tempState();
    const b = tempState();
    try {
      const spA = new Scratchpad(a);
      const spB = new Scratchpad(b);
      spA.record("shared-key", { from: "a" });
      expect(spB.lookup("shared-key")).toBeUndefined();
      expect(spA.lookup("shared-key")).toEqual({ from: "a" });
    } finally {
      cleanup(a);
      cleanup(b);
    }
  });
});
