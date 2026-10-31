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
export type { AgentRunResult, PreflightSpec } from "./types.js";
export { resolveTracerScript, runTracerCommand, readTraceResult, runPreflight, type TracerResult, type TracerCheck, type PreflightResult } from "./workflow-tracer.js";
export { WorkflowStore } from "./store.js";
export { PipelineStore, type PipelineRecord, type PipelineStageRecord, type PipelineSchedule } from "./pipeline-store.js";
export { readNudgeState, writeNudgeState, canNudge, type NudgeState, type NudgeCheck } from "./nudge-gate.js";
export { readPipelinePrefs, writePipelinePrefs, type PipelinePrefs, type PipelineMode } from "./pipeline-prefs.js";
export { listPresets, loadPreset, savePreset, deletePreset, type PipelinePreset } from "./pipeline-presets.js";
export { agentrunTool, sopArchitectTool, sopCheckRequiredToolsTool, sopResearchToolAlternativesTool, workflowTraceTool, pipelineStatusTool, pipelinePrefsTool, pipelinePresetTool, pipelineScheduleTool, nudgeGateTool, icmToDslTool } from "./tool.js";
export { icmToDsl, saveDslWorkflow, type IcmToDslResult } from "./icm-to-dsl.js";
export { createPiAgentRunExtension, type PiExtensionAPI } from "./pi-extension.js";
