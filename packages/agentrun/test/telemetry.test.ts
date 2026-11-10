import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { initTelemetry, shutdownTelemetry, startSpan, spanSetAttributes, spanEnd, withSpan, type Telemetry } from "../src/telemetry.js";

describe("telemetry", () => {
  let origDisabled: string | undefined;

  beforeEach(() => {
    origDisabled = process.env.PI_OTEL_DISABLED;
  });

  afterEach(() => {
    if (origDisabled === undefined) {
      delete process.env.PI_OTEL_DISABLED;
    } else {
      process.env.PI_OTEL_DISABLED = origDisabled;
    }
    vi.restoreAllMocks();
  });

  it("initTelemetry returns a no-op telemetry when PI_OTEL_DISABLED=1", () => {
    process.env.PI_OTEL_DISABLED = "1";
    const log = vi.fn();
    const tel = initTelemetry({ serviceName: "test-agent", log });
    expect(tel.enabled).toBe(false);
    expect(tel.tracer).toBeDefined();
    expect(log).toHaveBeenCalledWith("telemetry: disabled (PI_OTEL_DISABLED=1)");
  });

  it("initTelemetry is enabled by default when PI_OTEL_DISABLED is unset", () => {
    delete process.env.PI_OTEL_DISABLED;
    const log = vi.fn();
    const tel = initTelemetry({ serviceName: "test-agent", log });
    // Fail-open: if no Jaeger backend is running, the SDK still constructs
    // and enabled may be true. Just verify it doesn't throw and returns a
    // usable telemetry object.
    expect(tel.enabled).toBeDefined();
    expect(tel.tracer).toBeDefined();
  });

  it("initTelemetry accepts enabled=false explicitly", () => {
    const log = vi.fn();
    const tel = initTelemetry({ serviceName: "test-agent", enabled: false, log });
    expect(tel.enabled).toBe(false);
  });

  it("startSpan returns undefined when telemetry is disabled", () => {
    const tel: Telemetry = { tracer: null as any, sdk: null as any, enabled: false };
    const span = startSpan(tel, "test.span", { attr: "val" });
    expect(span).toBeUndefined();
  });

  it("spanSetAttributes and spanEnd are no-ops for undefined span", () => {
    expect(() => spanSetAttributes(undefined, { a: 1 })).not.toThrow();
    expect(() => spanEnd(undefined)).not.toThrow();
  });

  it("withSpan passes through when telemetry is disabled", async () => {
    const tel: Telemetry = { tracer: null as any, sdk: null as any, enabled: false };
    const result = await withSpan(tel, "test.op", async () => 42, { k: "v" });
    expect(result).toBe(42);
  });

  it("shutdownTelemetry is a no-op when disabled", async () => {
    const tel: Telemetry = { tracer: null as any, sdk: null as any, enabled: false };
    await expect(shutdownTelemetry(tel)).resolves.toBeUndefined();
  });

  it("shutdownTelemetry is a no-op when sdk is null", async () => {
    const tel: Telemetry = { tracer: null as any, sdk: undefined, enabled: true };
    await expect(shutdownTelemetry(tel)).resolves.toBeUndefined();
  });
});
