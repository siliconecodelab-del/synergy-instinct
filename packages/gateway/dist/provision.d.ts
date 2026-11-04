import type { InkboxProvisioner } from "@open-instinct/inkbox";
import { type ComposioPlatform } from "./composio.js";
import { type Logger } from "./logger.js";
import { type UserRecord, type UserStore } from "./store.js";
import type { GatewayTemplate } from "./templates.js";
export declare const DEFAULT_MARITIME_BASE_URL = "https://api.maritime.sh";
export declare const DEFAULT_IDLE_TTL_SECONDS = 900;
/**
 * The port Maritime injects as $PORT for framework "custom" (port 8080 is taken
 * inside the VM). The create body sends the same value as `exposedPort` and as an
 * explicit PORT env var, so the recorded port always equals the bound port.
 * packages/cli/src/maritime.ts carries the same constant for `instinct deploy`.
 */
export declare const MARITIME_AGENT_PORT = 18789;
/** Matches deploy/.env.example and core's DEFAULT_TOOLKITS. Linear is Composio-managed; custom_oxygen is the gateway's DCR toolkit. */
export declare const DEFAULT_COMPOSIO_TOOLKITS = "gmail,googlecalendar,googlecontacts,linear,custom_oxygen";
/** A model id Maritime's metered OpenAI-compatible proxy serves. Override with INSTINCT_MARITIME_MODEL. */
export declare const DEFAULT_MARITIME_LLM_MODEL = "gpt-5.4";
export interface ProvisionInput {
    name: string;
    phone: string;
    email?: string;
    handle: string;
    /** Company brain from signup: canonical owner/repo (already normalized by validate). */
    brainRepo?: string;
    /** Private-repo token from signup (already normalized by validate). */
    brainToken?: string;
}
export interface MaritimeProvisionOptions {
    apiKey: string;
    baseUrl?: string;
    /** Docker image built from deploy/Dockerfile.agent. */
    agentImage: string;
    /** Extra env vars for every agent (model keys, feature flags). Keys that look like secrets are marked secret. */
    extraEnv?: Record<string, string>;
    idleTtlSeconds?: number;
    /** Ask Maritime to inject its metered LLM credentials and point INSTINCT_MODEL at them. */
    useMaritimeLlm?: boolean;
    /** Model id behind `openai-compatible/`. Default DEFAULT_MARITIME_LLM_MODEL. */
    maritimeModel?: string;
    /**
     * A narrow `scopes:["computers"]` API key handed to agents as their own
     * MARITIME_API_KEY, so the fleet key never reaches an agent. Absent means
     * agents run without a hosted computer (the in-VM desktop still works).
     */
    computersKey?: string;
    /** Give each VM a Linux desktop (4 GiB, 2 vCPU). Default true when no template sets hardware. Templates control their own `hardware.desktop`. */
    desktop?: boolean;
}
/** Stripe Link Agent Wallet credentials handed to every agent so it can pay for things. */
export interface LinkPassthrough {
    clientId: string;
    clientSecret?: string;
    stripePublishableKey?: string;
}
export interface ProvisionDeps {
    inkbox: InkboxProvisioner;
    maritime: MaritimeProvisionOptions;
    /** Public base URL of this gateway, used for the webhook subscription and OAuth redirects. */
    publicUrl: string;
    inkboxBaseUrl?: string;
    store: UserStore;
    anthropicApiKey?: string;
    composioApiKey?: string;
    /** Comma-separated Composio toolkit slugs. Only sent with composioApiKey. Default DEFAULT_COMPOSIO_TOOLKITS. */
    composioToolkits?: string;
    /** Built executor toolkit client. Its presence marks the executor as configured (per-user connected accounts, toolkit filtering). */
    composio?: ComposioPlatform;
    /** Fleet-wide GitHub token: fallback for brain pushes when the person supplied none. */
    githubToken?: string;
    link?: LinkPassthrough;
    /** Deploy template from the registry. Persona/instructions ride as env seeds; skills are pushed to /data/skills. */
    template?: GatewayTemplate;
    fetchImpl?: typeof fetch;
    logger?: Logger;
    /** Resume a record the server already created. Otherwise the record is found by handle or created. */
    userId?: string;
}
/** What agentEnvFor and maritimeCreateBody need from the deps. */
export type AgentEnvDeps = Pick<ProvisionDeps, "anthropicApiKey" | "composioApiKey" | "composioToolkits" | "composio" | "maritime" | "link" | "inkboxBaseUrl" | "template" | "githubToken"> & {
    publicUrl?: string;
};
/**
 * The effective Composio toolkit list for one provision: the template's list
 * wins over the fleet default (the same rule applyTemplateEnv applies later).
 */
export declare function effectiveToolkits(deps: Pick<AgentEnvDeps, "composioToolkits" | "template">): string;
/** True when the effective toolkit list asks for the executor (and therefore needs a connected account). */
export declare function executorRequested(deps: Pick<AgentEnvDeps, "composioToolkits" | "template">): boolean;
export interface EnvVarInput {
    key: string;
    value: string;
    isSecret: boolean;
}
export declare function newUserId(): string;
export declare function webhookUrlFor(publicUrl: string, userId: string): string;
/** Where Link sends the browser after the owner approves the wallet connection. */
/**
 * One redirect URI for every agent behind this gateway, so the operator registers a single URI
 * with Stripe. The agent prefixes the OAuth state with its handle and the gateway routes on it;
 * the per-user path `/oauth/link/callback/<userId>` still works for older agents.
 */
export declare function linkRedirectUriFor(publicUrl: string, _userId?: string): string;
/** The persona Maritime shows in its dashboard. The agent's real prompt is built in core. */
export declare function personaFor(input: {
    name: string;
    handle: string;
}): string;
export declare function agentEnvFor(user: UserRecord, deps: AgentEnvDeps): EnvVarInput[];
export declare function maritimeCreateBody(user: UserRecord, deps: AgentEnvDeps): Record<string, unknown>;
export declare class MaritimeApiError extends Error {
    readonly status: number;
    readonly detail: string;
    constructor(status: number, detail: string);
}
export declare function maritimeRequest(deps: Pick<ProvisionDeps, "maritime" | "fetchImpl">, method: string, path: string, body?: unknown): Promise<unknown>;
/**
 * Recompute an agent's env and push only the keys that differ from what
 * Maritime already has. Secrets are never compared against Maritime's masked
 * value (****xxxx) — a stored secret always overwrites, so a rotated key
 * reaches the agent. A ready agent's toolkit list, template env and model can
 * all change after first provision (a new toolkit ships, the operator edits a
 * template); without this, the agent stays frozen on its original env forever.
 *
 * Pushing to Maritime's env store is only half the job: a running or sleeping
 * container does NOT pick store changes up (hot `reload-env` never reaches the
 * orchestrator process, `restart` does not restart the container, and a
 * reload-triggered rebuild re-applies the CREATE-time payload, which for older
 * agents predates later vars). The only reliable application is a fresh
 * container cycle: stop → start deploys from the current store, and sleep
 * checkpoints after that capture the new env so subsequent wakes keep it.
 * Every sync therefore ends with that cycle — secrets always re-push anyway,
 * so gating the bounce on "something changed" would never skip it in practice.
 * Callers are reconnects, the admin reprovision endpoint and the per-person
 * OAuth callback: all rare, all wanting a live agent on current env.
 */
export declare function syncAgentEnv(user: UserRecord, deps: AgentEnvDeps & Pick<ProvisionDeps, "maritime"> & Pick<ProvisionDeps, "fetchImpl" | "logger">): Promise<{
    synced: number;
    total: number;
    refreshed: boolean;
}>;
/**
 * Ensure this owner has an active Composio connected account carrying their own
 * Postiz BYOK key: reuse a live account, replace a stale id, mint when it never
 * existed (the saved key predates account minting). Used by provisioning, the
 * admin reprovision endpoint and ready-agent reconnects. Never throws — a
 * Composio hiccup is logged so the next heal can retry.
 */
export declare function healPostizAccount(user: UserRecord, deps: Pick<ProvisionDeps, "composio">, store: UserStore, log?: Logger): Promise<UserRecord>;
/**
 * Promote a completed Oxygen OAuth dance even when the browser callback never
 * arrived (Composio can fail its final redirect with "Invalid or expired state"
 * while the account is already ACTIVE). Reuses a live account, drops a stale
 * id, and promotes the pending account the connect page recorded once Composio
 * reports it ACTIVE, owned by this person's handle, for custom_oxygen. Never
 * throws — a Composio hiccup is logged so the next heal can retry.
 */
export declare function healOxygenAccount(user: UserRecord, deps: Pick<ProvisionDeps, "composio">, store: UserStore, log?: Logger): Promise<UserRecord>;
/**
 * Provision one person end to end. Completed steps are recorded before moving
 * on, so retries reuse the resources already saved for this person.
 */
export declare function provisionUser(input: ProvisionInput, deps: ProvisionDeps): Promise<UserRecord>;
//# sourceMappingURL=provision.d.ts.map