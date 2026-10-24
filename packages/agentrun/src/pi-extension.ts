/**
 * Pi extension bridge for Open Instinct + AgentRun.
 *
 * `createPiAgentRunExtension` wraps `@parcha/agentrun-pi`'s `createAgentRunExtension`
 * with Open Instinct's tool registry, Jev runner, and policy guard, so the `/agentrun`
 * Pi extension commands work inside Pi sessions against this agent.
 *
 * Users install the Pi extension separately:
 *   pi install npm:@parcha/agentrun-pi@beta -l
 *   pi --offline
 * Then inside Pi: /agentrun demo, /agentrun run, /agentrun dry-run, /agentrun save, /agentrun load
 */
import { createAgentRunExtension } from "@parcha/agentrun-pi/extension";
import type { AgentRunAdapterDeps } from "./types.js";

/** Minimal structural type for Pi's ExtensionAPI (from @earendil-works/pi-coding-agent). */
export interface PiExtensionAPI {
  install(extension: (ctx: unknown) => void): void;
}

/** Build the `/agentrun` Pi extension configured for Open Instinct. */
export function createPiAgentRunExtension(deps: AgentRunAdapterDeps): (pi: PiExtensionAPI) => void {
  const { registry, jevRunner } = deps;

  return (pi) => {
    const install = (createAgentRunExtension as any)({
      hostTools: () => {
        const tools: any[] = [];
        for (const t of registry.all()) {
          tools.push({
            name: t.spec.name,
            label: t.spec.label,
            description: t.spec.description,
            parameters: t.spec.parameters,
            executionMode: "sequential",
            execute: async (_toolCallId: string, params: unknown, _signal: AbortSignal | undefined, _onUpdate: ((result: unknown) => void) | undefined) => {
              const result = await t.spec.execute(params, {} as any, _signal);
              return { content: [{ type: "text", text: String(result) }], details: undefined };
            },
          });
        }
        return tools;
      },
      createJudge: () => {
        const jev = jevRunner
          ? jevRunner
          : // Offline fallback: fixed-probability noul answers (no key, no network).
            async (_params: { label: string; kind: string; state: unknown; questions: Record<string, { type: string }> }) => {
              const answers: Record<string, { type: "noul"; noul: number }> = {};
              for (const [id, q] of Object.entries(_params.questions)) {
                if (q.type === "noul") answers[id] = { type: "noul", noul: 0.5 };
              }
              return { answers, model: null, usage: null, cost_usd: null };
            };
        return (_params: {
          label: string;
          kind: string;
          state: unknown;
          questions: Record<string, { type: string }>;
          signal?: AbortSignal;
        }) => {
          return jev({
            label: _params.label,
            kind: _params.kind as any,
            state: _params.state,
            questions: _params.questions as any,
            signal: _params.signal,
          });
        };
      },
      runtimeLimits: {
        deadlineMs: 600_000,
        modelRequests: 50,
        judgeCalls: 100,
        toolAttempts: 100,
        nodeMaxTurns: 8,
        nodeMaxSubmissions: 3,
        nodeTimeoutMs: 120_000,
      },
    });
    install(pi as any);
  };
}
