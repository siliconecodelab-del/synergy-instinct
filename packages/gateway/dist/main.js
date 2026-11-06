import { InkboxProvisioner } from "@open-instinct/inkbox";
import { Inkbox } from "@inkbox/sdk";
import { ensureComputersKey } from "./computersKey.js";
import { ComposioPlatform } from "./composio.js";
import { consoleLogger } from "./logger.js";
import { createGateway } from "./server.js";
import { UserStore } from "./store.js";
export const DEFAULT_AGENT_IMAGE = "ghcr.io/siliconecodelab-del/synergy-instinct-agent:latest";
/** Send a proactive welcome iMessage on the first inbound message from a user. */
async function sendWelcomeMessage(user) {
    try {
        const inkbox = new Inkbox({ apiKey: user.identityApiKey });
        const identity = await inkbox.getIdentity(user.handle);
        if (!identity?.imessageEnabled)
            return;
        await identity.sendIMessage({
            to: user.phone,
            text: `Hi ${user.name}! I'm your Instinct agent (@${user.handle}). I'm here and ready to help — I can assist with outbound campaigns, company brain research, SOP generation, and more. What would you like to work on first?`,
        });
    }
    catch (err) {
        console.warn("[welcome] failed to send", { userId: user.id, error: err instanceof Error ? err.message : String(err) });
    }
}
function truthy(v) {
    return v !== undefined && /^(1|true|yes)$/i.test(v.trim());
}
/**
 * A hung external API must never keep the gateway from listening. On timeout
 * the boot step is treated as failed (executor off / no hosted computer) —
 * both are non-fatal states the gateway is designed to run in.
 */
function withTimeout(label, promise, ms, log) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            log.warn(`${label}_timeout`, { effect: "continuing without it", ms });
            reject(new Error(`${label} timed out after ${ms}ms`));
        }, ms);
        timer.unref();
        promise.then((value) => {
            clearTimeout(timer);
            resolve(value);
        }, (err) => {
            clearTimeout(timer);
            reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
}
const BOOT_TIMEOUT_MS = 30_000;
/** The only place the gateway reads process.env. Everything else takes options. */
export function readEnv(env) {
    const port = Number(env["PORT"] ?? 8787);
    const maritimeApiKey = env["MARITIME_API_KEY"];
    if (!maritimeApiKey)
        throw new Error("MARITIME_API_KEY is required (the gateway forwards every message through Maritime).");
    const publicUrl = env["GATEWAY_PUBLIC_URL"] ?? `http://localhost:${port}`;
    const idle = env["INSTINCT_IDLE_TTL_SECONDS"] ? Number(env["INSTINCT_IDLE_TTL_SECONDS"]) : undefined;
    const linkClientId = env["LINK_CLIENT_ID"] || undefined;
    const link = linkClientId
        ? {
            clientId: linkClientId,
            ...(env["LINK_CLIENT_SECRET"] ? { clientSecret: env["LINK_CLIENT_SECRET"] } : {}),
            ...(env["STRIPE_PUBLISHABLE_KEY"] ? { stripePublishableKey: env["STRIPE_PUBLISHABLE_KEY"] } : {}),
        }
        : undefined;
    return {
        port,
        publicUrl,
        dataDir: env["GATEWAY_DATA_DIR"] ?? "./.instinct-gateway",
        inkboxAdminApiKey: env["INKBOX_ADMIN_API_KEY"] || undefined,
        inkboxBaseUrl: env.INKBOX_BASE_URL || (env.NODE_ENV === "production" ? "https://inkbox.ai" : `http://localhost:${port}`),
        maritimeApiKey,
        maritimeBaseUrl: env["MARITIME_API_URL"] || undefined,
        agentImage: env["INSTINCT_AGENT_IMAGE"] || DEFAULT_AGENT_IMAGE,
        signupSecret: env["GATEWAY_SIGNUP_SECRET"] || undefined,
        allowOpenSignup: truthy(env["GATEWAY_ALLOW_OPEN_SIGNUP"]) || truthy(env["GATEWAY_OPEN_SIGNUP"]),
        trustProxy: truthy(env["GATEWAY_TRUST_PROXY"]),
        anthropicApiKey: env["ANTHROPIC_API_KEY"] || undefined,
        composioApiKey: env["COMPOSIO_API_KEY"] || undefined,
        composioToolkits: env["COMPOSIO_TOOLKITS"] || env["INSTINCT_COMPOSIO_TOOLKITS"] || undefined,
        composioMode: env["COMPOSIO_MODE"]?.trim() || undefined,
        contextDevApiKey: env["CONTEXT_DEV_API_KEY"] || undefined,
        ampleSignup: truthy(env["AMPLE_SIGNUP"]),
        ampleSharedCredential: Boolean(env["AMPLE_CLIENT_ID"] || env["AMPLE_CLIENT_SECRET"] || env["AMPLE_TOKEN"]),
        idleTtlSeconds: idle !== undefined && Number.isFinite(idle) ? idle : undefined,
        useMaritimeLlm: truthy(env["INSTINCT_USE_MARITIME_LLM"]),
        maritimeModel: env["INSTINCT_MARITIME_MODEL"] || undefined,
        link,
        templatesDir: env["GATEWAY_TEMPLATES_DIR"] || undefined,
        /** Supabase project URL for verifying JWTs on the agent snapshot endpoint. */
        supabaseUrl: env["SUPABASE_URL"] || undefined,
        /** Supabase service role key for verifying Supabase JWTs. */
        supabaseServiceRoleKey: env["SUPABASE_SERVICE_ROLE_KEY"] || undefined,
        executorMcpUrl: env["EXECUTOR_MCP_URL"] || undefined,
        executorMcpToken: env["EXECUTOR_MCP_TOKEN"] || undefined,
        postizMcpUrl: env["POSTIZ_MCP_URL"] || undefined,
        adminToken: env["GATEWAY_ADMIN_TOKEN"] || undefined,
        maritimeComputersKey: env["MARITIME_COMPUTERS_API_KEY"] || undefined,
        githubToken: env["GITHUB_TOKEN"] || undefined,
    };
}
/**
 * Signup provisions an Inkbox identity and a Maritime VM, both billed to the
 * operator. With a provisioner configured the form is live, so it must be
 * behind an invite code unless the operator opts into open signup by name.
 */
export function checkSignupPolicy(cfg) {
    if (!cfg.inkboxAdminApiKey)
        return { ok: true, open: false };
    if (cfg.signupSecret)
        return { ok: true, open: false };
    if (cfg.allowOpenSignup)
        return { ok: true, open: true };
    return {
        ok: false,
        reason: "INKBOX_ADMIN_API_KEY is set but GATEWAY_SIGNUP_SECRET is not. Every signup creates a billed identity and VM, so set an invite code, " +
            "or set GATEWAY_ALLOW_OPEN_SIGNUP=1 to run the form open to the internet on purpose.",
    };
}
/** Settings every agent gets. Only keys safe to share across people belong here. */
export function agentExtraEnv(cfg) {
    const env = {};
    if (cfg.composioMode)
        env["COMPOSIO_MODE"] = cfg.composioMode;
    if (cfg.contextDevApiKey)
        env["CONTEXT_DEV_API_KEY"] = cfg.contextDevApiKey;
    if (cfg.ampleSignup)
        env["AMPLE_SIGNUP"] = "1";
    return Object.keys(env).length > 0 ? env : undefined;
}
/**
 * Boot: resolve the narrow computers key and register the executor toolkit
 * BEFORE accepting signups, so the first agent is provisioned against ready
 * state. Both failures are non-fatal by design (no hosted computer / no
 * executor) — each is logged loudly and the gateway still comes up.
 */
export async function startGateway(cfg) {
    const log = consoleLogger;
    const policy = checkSignupPolicy(cfg);
    if (!policy.ok)
        throw new Error(policy.reason);
    if (policy.open) {
        log.warn("gateway.open_signup", {
            warning: "Signup is open to anyone. Each signup bills your Maritime wallet and Inkbox plan. Set GATEWAY_SIGNUP_SECRET to close it.",
        });
    }
    const store = new UserStore(cfg.dataDir);
    const inkbox = cfg.inkboxAdminApiKey
        ? new InkboxProvisioner({ adminApiKey: cfg.inkboxAdminApiKey, baseUrl: cfg.inkboxBaseUrl })
        : undefined;
    if (!inkbox)
        log.warn("gateway.relay_only", { reason: "INKBOX_ADMIN_API_KEY not set; signup disabled" });
    if (!cfg.publicUrl.startsWith("https://"))
        log.warn("gateway.public_url_not_https", { publicUrl: cfg.publicUrl });
    if (cfg.ampleSharedCredential) {
        log.warn("gateway.ample_credential_ignored", {
            reason: "An Ample credential is not forwarded to agents: they would all deploy into one account. Set AMPLE_SIGNUP=1 to give each person an account of their own.",
        });
    }
    // Fleet isolation: agents get a narrow computers-scoped key, never the fleet key.
    const computersKey = await withTimeout("computers_key", ensureComputersKey({
        apiKey: cfg.maritimeApiKey,
        baseUrl: cfg.maritimeBaseUrl,
        dataDir: cfg.dataDir,
        override: cfg.maritimeComputersKey,
        logger: log,
    }), BOOT_TIMEOUT_MS, log).catch(() => undefined);
    if (computersKey)
        log.info("computers_key.ready", { source: cfg.maritimeComputersKey ? "override" : "minted" });
    // Composio: each custom toolkit boots independently (executor needs URL+token,
    // oxygen boots DCR registration, postiz needs the wrapper URL). Linear is
    // Composio-managed and needs nothing. A boot failure logs loudly per toolkit
    // and leaves the gateway running without it — template lists that name a
    // dead custom toolkit are stripped at provision time.
    let composio;
    if (cfg.composioApiKey) {
        const platform = new ComposioPlatform({
            apiKey: cfg.composioApiKey,
            ...(cfg.executorMcpUrl && cfg.executorMcpToken ? { appUrl: cfg.executorMcpUrl, token: cfg.executorMcpToken } : {}),
            ...(cfg.postizMcpUrl ? { postizAppUrl: cfg.postizMcpUrl } : {}),
        }, { logger: log });
        try {
            await withTimeout("composio_boot", platform.ensureBoot(), BOOT_TIMEOUT_MS, log);
        }
        catch (err) {
            log.error("composio.boot_failed", {
                error: err instanceof Error ? err.message : String(err),
                effect: "agents run without whichever toolkits failed to boot",
            });
        }
        if (platform.anyReady)
            composio = platform;
    }
    else {
        log.warn("composio.disabled", {
            reason: "COMPOSIO_API_KEY not set",
        });
    }
    const server = createGateway({
        store,
        publicUrl: cfg.publicUrl,
        inkbox,
        inkboxBaseUrl: cfg.inkboxBaseUrl,
        maritime: {
            apiKey: cfg.maritimeApiKey,
            baseUrl: cfg.maritimeBaseUrl,
            agentImage: cfg.agentImage,
            idleTtlSeconds: cfg.idleTtlSeconds,
            useMaritimeLlm: cfg.useMaritimeLlm,
            maritimeModel: cfg.maritimeModel,
            computersKey,
            extraEnv: agentExtraEnv(cfg),
        },
        signupSecret: cfg.signupSecret,
        anthropicApiKey: cfg.anthropicApiKey,
        composioApiKey: cfg.composioApiKey,
        composioToolkits: cfg.composioToolkits,
        composio,
        githubToken: cfg.githubToken,
        adminToken: cfg.adminToken,
        link: cfg.link,
        trustProxy: cfg.trustProxy,
        templateDir: cfg.templatesDir,
        supabaseUrl: cfg.supabaseUrl,
        supabaseServiceRoleKey: cfg.supabaseServiceRoleKey,
        logger: log,
        // Proactive welcome: on the first inbound iMessage, introduce the agent and
        // its capabilities before relaying the message to the agent process.
        onInbound: async (user, event) => {
            if (user.welcomeSent)
                return;
            const eventType = event.event_type ?? event.eventType;
            if (eventType !== "imessage.received")
                return;
            if (!user.phone || !user.identityApiKey)
                return;
            await sendWelcomeMessage(user);
            store.save({ ...user, welcomeSent: true });
            log.info("welcome.sent", { userId: user.id, handle: user.handle, to: user.phone });
        },
        // The triage endpoint called with an identity-scoped key answers for that identity, so its QR fits the user.
        routerInfoFor: (user) => new InkboxProvisioner({ adminApiKey: user.identityApiKey, baseUrl: cfg.inkboxBaseUrl }).routerInfo(),
    });
    server.listen(cfg.port, "0.0.0.0", () => {
        log.info("gateway.listening", {
            port: cfg.port,
            publicUrl: cfg.publicUrl,
            users: store.all().length,
            signup: Boolean(inkbox),
            link: Boolean(cfg.link),
            executor: Boolean(composio?.executorReady),
            oxygen: Boolean(composio?.oxygenReady),
            postiz: Boolean(composio?.postizReady),
            computer: Boolean(computersKey),
            adminApi: Boolean(cfg.adminToken),
        });
        server.resumePending();
        // Older subscriptions were made before call.ended existed; each boot tops them up.
        void server.backfillWebhookEvents();
    });
    let stopping = false;
    const stop = () => {
        if (stopping)
            return;
        stopping = true;
        const deadline = setTimeout(() => process.exit(0), 10_000);
        deadline.unref();
        server.close(() => { void server.drainWebhooks().finally(() => process.exit(0)); });
    };
    process.once("SIGTERM", stop);
    process.once("SIGINT", stop);
    return server;
}
const isMain = process.argv[1] !== undefined && import.meta.url === new URL(`file://${process.argv[1]}`).href;
if (isMain) {
    startGateway(readEnv(process.env)).catch((err) => {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
    });
}
//# sourceMappingURL=main.js.map