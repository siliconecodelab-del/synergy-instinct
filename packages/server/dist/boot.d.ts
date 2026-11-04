import type { Model } from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import { AgentRuntime, Scheduler, StateDir } from "@open-instinct/core";
import type { InboundMessage, InstinctConfig, Outbox, RegisteredTool } from "@open-instinct/core";
import { InkboxChannel } from "@open-instinct/inkbox";
import type { CallEndedEvent, CallOrigination } from "@open-instinct/inkbox";
import type { ComputerBackend } from "@open-instinct/computer";
import { ComposioApps } from "@open-instinct/apps";
import { type AmpleCredentials } from "@open-instinct/ample";
import { type ChatReplyBuffer } from "./console-outbox.js";
import { type LinkWalletLike, type PaymentsModule } from "./payments.js";
import { makeAdapters, WorkflowStore } from "@open-instinct/agentrun";
export interface BootOptions {
    streamFn?: StreamFn;
    model?: Model<any>;
    outbox?: Outbox;
    logger?: (m: string) => void;
    skillsDir?: string;
    /** Override for tests. Default: real fetch. */
    fetchImpl?: typeof fetch;
    /** Override for tests: the payments module to wire instead of importing @open-instinct/payments. */
    payments?: PaymentsModule;
}
export interface BootResult {
    runtime: AgentRuntime;
    state: StateDir;
    config: InstinctConfig;
    scheduler: Scheduler;
    outbox: Outbox;
    close(): Promise<void>;
    computerKind?: string;
    apps?: ComposioApps;
    /** Toolkits Composio reports as connected at boot, for the status page. */
    appsConnected?: string[];
    startedAt: number;
    modelSpec: string;
    /** Finished chat replies waiting for the next /chat on their conversation. */
    chatBuffer: ChatReplyBuffer;
    /** Set when LINK_CLIENT_ID, LINK_CLIENT_SECRET and STRIPE_PUBLISHABLE_KEY are present and the package is installed. */
    wallet?: LinkWalletLike;
    /** Complete compact Inkbox events before handing them to the runtime. */
    hydrateInbound?: (message: InboundMessage) => Promise<InboundMessage>;
    /** Set with Inkbox: text the owner the outcome of a finished phone call. */
    onCallEnded?(event: CallEndedEvent): Promise<void>;
    /** AgentRun workflow integration (optional, INSTINCT_AGENTRUN=1). */
    agentrun?: {
        store: WorkflowStore;
        adapters: ReturnType<typeof makeAdapters>;
        stateDir: StateDir;
        run: (workflow: unknown, input: Record<string, unknown>, options?: {
            runId?: string;
            signal?: AbortSignal;
        }) => Promise<{
            status: "complete" | "escalated";
            output?: unknown;
            escalation?: any;
        }>;
    };
}
export declare const DEFAULT_MARITIME_MCP_URL = "https://mcp.maritime.sh";
export declare function boot(env: NodeJS.ProcessEnv, opts?: BootOptions): Promise<BootResult>;
/** Env variable per Pi provider id. Anything not listed falls back to <PROVIDER>_API_KEY. */
export declare const PROVIDER_KEY_ENV: Record<string, string[]>;
/**
 * Provider key from the env the server was handed (not process.env, so tests and
 * embedders control it). Pi would read process.env itself; passing the key keeps
 * the lookup in one place and lets `instinct dev` and embedders inject keys.
 */
export declare function apiKeyFor(provider: string, env: NodeJS.ProcessEnv): string | undefined;
/** INKBOX_CALL_ORIGINATION, when it names a line Inkbox knows. Anything else is logged by the tool at boot. */
export declare function callOriginationFrom(env: NodeJS.ProcessEnv): CallOrigination | undefined;
/** The call.ended handler: fetch the transcript when the event has none, then one text to the owner. */
export declare function callReporter(channel: Pick<InkboxChannel, "callTranscript">, relay: (text: string, originKey: string) => Promise<boolean>, log: (m: string) => void): (event: CallEndedEvent) => Promise<void>;
/** An Ample agent credential (preferred: it never expires) or a plain token. */
export declare function ampleCredentials(env: NodeJS.ProcessEnv): AmpleCredentials | undefined;
export type { RegisteredTool, ComputerBackend };
//# sourceMappingURL=boot.d.ts.map