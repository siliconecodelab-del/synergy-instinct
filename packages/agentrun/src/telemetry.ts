/**
 * OpenTelemetry instrumentation for AgentRun observability.
 *
 * Creates a Node.js OTel tracer provider and exports spans via OTLP/HTTP to a
 * backend (e.g. Arize Phoenix, Aspire Dashboard, Jaeger). Fail-open: if the
 * backend is unreachable, spans are dropped and the agent keeps running.
 *
 * Span hierarchy:
 *   session (agent lifetime)
 *   └── turn (one /chat turn)
 *       ├── tool.<name> (each tool call)
 *       ├── workflow.<name> (each AgentRun workflow run)
 *       │   └── step.<node-label> (each workflow step)
 *       └── decision.<kind> (each policy/approval/spend decision)
 */
import {
  NodeSDK,
} from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import {
  trace,
  context,
  type Span,
  type Tracer,
  type SpanAttributes,
} from "@opentelemetry/api";

export interface Telemetry {
  tracer: Tracer;
  sdk: NodeSDK;
  enabled: boolean;
}

/** Initialize OpenTelemetry. Returns a no-op telemetry when OTel is disabled or initialization fails. */
export function initTelemetry(opts: {
  serviceName?: string;
  serviceVersion?: string;
  endpoint?: string;
  enabled?: boolean;
  log?: (m: string) => void;
}): Telemetry {
  const {
    serviceName = "instinct-agent",
    serviceVersion,
    endpoint = process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318/v1/traces",
    enabled = process.env.PI_OTEL_DISABLED !== "1",
    log = () => {},
  } = opts;

  if (!enabled) {
    log("telemetry: disabled (PI_OTEL_DISABLED=1)");
    return { tracer: trace.getTracer("disabled"), sdk: null as unknown as NodeSDK, enabled: false };
  }

  let sdk: NodeSDK;
  try {
    const exporter = new OTLPTraceExporter({ url: endpoint });

    sdk = new NodeSDK({
      traceExporter: exporter,
    });

    sdk.start();
    log(`telemetry: OTel initialized, endpoint=${endpoint}`);
  } catch (err) {
    log(`telemetry: failed to initialize (${err instanceof Error ? err.message : String(err)}), running no-op`);
    return { tracer: trace.getTracer("disabled"), sdk: null as unknown as NodeSDK, enabled: false };
  }

  return { tracer: trace.getTracer(serviceName), sdk, enabled: true };
}

/** Shutdown the OTel SDK gracefully. */
export async function shutdownTelemetry(telemetry: Telemetry): Promise<void> {
  if (!telemetry.enabled || !telemetry.sdk) return;
  try {
    await telemetry.sdk.shutdown();
  } catch {
    // Best effort.
  }
}

/** Start a child span under the current context. */
export function startSpan(telemetry: Telemetry | undefined, name: string, attributes?: SpanAttributes): Span | undefined {
  if (!telemetry?.enabled) return undefined;
  return telemetry.tracer.startSpan(name, { attributes });
}

/** Set attributes on a span if it exists. */
export function spanSetAttributes(span: Span | undefined, attributes: SpanAttributes): void {
  if (span) span.setAttributes(attributes);
}

/** End a span if it exists. */
export function spanEnd(span: Span | undefined, status?: { code: number; message?: string }): void {
  if (!span) return;
  if (status) {
    span.setStatus({ code: status.code, message: status.message });
  }
  span.end();
}

/** Wrap an async function in a span. */
export async function withSpan<T>(
  telemetry: Telemetry | undefined,
  name: string,
  fn: () => Promise<T>,
  attributes?: SpanAttributes,
): Promise<T> {
  if (!telemetry?.enabled) return fn();
  const span = telemetry.tracer.startSpan(name, { attributes });
  const ctx = trace.setSpan(context.active(), span);
  try {
    const result = await context.with(ctx, async () => fn());
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (err) {
    span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) }); // ERROR
    throw err;
  } finally {
    span.end();
  }
}
