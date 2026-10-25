/**
 * @open-instinct/agentrun — AgentRun workflow integration for Open Instinct.
 *
 * Adapters, durable runner, workflow store, and the `agentrun` tool that bridge
 * `@parcha/agentrun-dsl` (and `@parcha/agentrun-jev`) to Open Instinct's Pi runtime,
 * tool registry, policy engine, and approval flow.
 *
 * Gate everything behind `INSTINCT_AGENTRUN=1` in `packages/server/src/boot.ts`.
 */
export { makeAdapters, type AgentRunAdapterDeps } from "./adapters.js";
export { runWorkflowWithRecovery, type AgentRunAdapters } from "./runner.js";
export type { AgentRunResult } from "./types.js";
export { WorkflowStore } from "./store.js";
export { agentrunTool, sopArchitectTool, sopCheckRequiredToolsTool } from "./tool.js";
export { createPiAgentRunExtension, type PiExtensionAPI } from "./pi-extension.js";
