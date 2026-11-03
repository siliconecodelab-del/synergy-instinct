/**
 * Admin-key operations: create an identity for a new user, mint its own API key,
 * wire webhooks, enable A2A, and read the iMessage router details for the
 * connect flow. Plain REST, so every call is testable with a fake fetch.
 */
import { createRest, errorDetail, InkboxHttpError, isHttpStatus } from "./http.js";
export class InkboxPlanLimitError extends Error {
    billingUrl;
    detail;
    constructor(message, billingUrl, detail) {
        super(message);
        this.name = "InkboxPlanLimitError";
        this.billingUrl = billingUrl;
        this.detail = detail;
    }
}
/** A connect or disconnect on the dedicated iMessage pool was refused. `code` is Inkbox's machine-readable reason when it gave one. */
export class InkboxConnectError extends Error {
    status;
    code;
    constructor(status, code, message) {
        super(message);
        this.status = status;
        this.code = code;
        this.name = "InkboxConnectError";
    }
}
export const CONNECT_FIRST_MESSAGE_MAX = 160;
function connectErrorCode(body) {
    if (!body || typeof body !== "object")
        return undefined;
    const b = body;
    if (typeof b.error === "string")
        return b.error;
    if (typeof b.code === "string")
        return b.code;
    const detail = b.detail;
    if (typeof detail === "string" && /^[a-z_]+$/.test(detail))
        return detail;
    if (detail && typeof detail === "object") {
        const d = detail;
        if (typeof d.error === "string")
            return d.error;
        if (typeof d.code === "string")
            return d.code;
    }
    return undefined;
}
export const DEFAULT_WEBHOOK_EVENTS = [
    "imessage.received",
    "imessage.reaction_received",
    "text.received",
    "message.received",
    "a2a.task.created",
    "a2a.task.message",
    "a2a.task.canceled",
    "a2a.sent_task.updated",
    "call.ended",
];
function str(v) {
    return typeof v === "string" && v.length > 0 ? v : undefined;
}
function toProvisioned(raw) {
    const phone = raw.phone_number && typeof raw.phone_number === "object" ? raw.phone_number : undefined;
    const mailbox = raw.mailbox && typeof raw.mailbox === "object" ? raw.mailbox : undefined;
    const tunnel = raw.tunnel && typeof raw.tunnel === "object" ? raw.tunnel : undefined;
    const out = {
        identityId: str(raw.id) ?? "",
        handle: str(raw.agent_handle) ?? "",
        email: str(raw.email_address) ?? str(mailbox?.email_address) ?? "",
        imessageEnabled: raw.imessage_enabled === true,
    };
    const number = str(phone?.number);
    if (number)
        out.phone = number;
    const host = str(tunnel?.public_host);
    if (host)
        out.tunnelHost = host;
    return out;
}
export class InkboxProvisioner {
    rest;
    constructor(opts) {
        const restOpts = { apiKey: opts.adminApiKey };
        if (opts.baseUrl)
            restOpts.baseUrl = opts.baseUrl;
        if (opts.fetchImpl)
            restOpts.fetchImpl = opts.fetchImpl;
        if (opts.sleep)
            restOpts.sleep = opts.sleep;
        this.rest = createRest(restOpts);
    }
    get billingUrl() {
        return `${this.rest.baseUrl}/console/billing`;
    }
    async getIdentity(handle) {
        try {
            const raw = await this.rest.request("GET", `/identities/${encodeURIComponent(handle)}`);
            return toProvisioned(raw);
        }
        catch (err) {
            if (isHttpStatus(err, 404))
                return undefined;
            throw err;
        }
    }
    /**
     * Create a fresh identity. An operator can explicitly import an existing one.
     * A taken handle gets a numeric suffix; a plan limit surfaces as InkboxPlanLimitError; a phone quota
     * (429) falls back to an identity without a dedicated number.
     */
    async provisionIdentity(input) {
        const base = input.handle.replace(/^@+/, "").toLowerCase();
        const wantIMessage = input.imessage ?? true;
        const existing = input.reuseExisting ? await this.getIdentity(base) : undefined;
        if (existing) {
            if (wantIMessage && !existing.imessageEnabled) {
                const raw = await this.rest.request("PATCH", `/identities/${encodeURIComponent(base)}`, { imessage_enabled: true });
                return toProvisioned(raw);
            }
            return existing;
        }
        let withPhone = input.phone ?? false;
        for (let attempt = 1; attempt <= 20; attempt++) {
            const handle = attempt === 1 ? base : `${base}-${attempt}`;
            const body = { agent_handle: handle, display_name: input.displayName, imessage_enabled: wantIMessage };
            if (input.description)
                body.description = input.description;
            if (withPhone)
                body.phone_number = { type: "local", incoming_call_action: "auto_reject" };
            try {
                const raw = await this.rest.request("POST", "/identities/", body);
                return toProvisioned(raw);
            }
            catch (err) {
                if (!(err instanceof InkboxHttpError))
                    throw err;
                if (err.status === 409)
                    continue;
                if (err.status === 402) {
                    throw new InkboxPlanLimitError(`Inkbox plan limit reached while creating "${handle}". Upgrade at ${this.billingUrl}.`, this.billingUrl, errorDetail(err.body));
                }
                if (err.status === 429 && withPhone) {
                    // Phone inventory is rate limited; the identity is still useful without a number.
                    withPhone = false;
                    attempt -= 1;
                    continue;
                }
                throw err;
            }
        }
        throw new Error(`could not find a free handle for "${base}" after 20 attempts`);
    }
    /** Identity-scoped key for the agent process. Shown once; store it in the agent's env. */
    async mintIdentityKey(identityId, label) {
        const raw = await this.rest.request("POST", "/api-keys", { label, scoped_identity_id: identityId });
        const key = str(raw.api_key) ?? str(raw.key);
        if (!key)
            throw new Error("Inkbox did not return an api_key");
        return key;
    }
    /** Create or rotate the per-identity webhook signing key. Shown once. */
    async createSigningKey(handle) {
        const raw = await this.rest.request("POST", `/identities/${encodeURIComponent(handle)}/signing-key`, {});
        const key = str(raw.signing_key);
        if (!key)
            throw new Error("Inkbox did not return a signing_key");
        return key;
    }
    async getSigningKeyStatus(handle) {
        return this.rest.request("GET", `/identities/${encodeURIComponent(handle)}/signing-key`);
    }
    /** Do not replace a key other receivers may still be using without an explicit rotation. */
    async ensureSigningKey(handle, opts = {}) {
        const status = await this.getSigningKeyStatus(handle);
        if (status.configured && !opts.rotate) {
            if (opts.knownSigningKey)
                return opts.knownSigningKey;
            throw new Error(`A signing key already exists for @${handle}. Supply INKBOX_SIGNING_KEY or explicitly rotate it with --rotate-signing-key.`);
        }
        return this.createSigningKey(handle);
    }
    async subscribeWebhooks(identityId, url, eventTypes = [...DEFAULT_WEBHOOK_EVENTS]) {
        const raw = await this.rest.request("POST", "/webhooks/subscriptions", {
            url,
            event_types: eventTypes,
            agent_identity_id: identityId,
        });
        const out = { subscriptionId: str(raw.id) ?? "" };
        const signingKey = str(raw.signing_key);
        if (signingKey)
            out.signingKey = signingKey;
        return out;
    }
    /**
     * Make sure an existing subscription carries every event in `eventTypes`, keeping the
     * ones it already has. Returns the events that were added. For identities subscribed
     * before a new event existed (call.ended arrived after the first fleets were provisioned).
     */
    async ensureWebhookEvents(subscriptionId, eventTypes = DEFAULT_WEBHOOK_EVENTS) {
        const raw = await this.rest.request("GET", `/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`);
        const have = new Set((Array.isArray(raw.event_types) ? raw.event_types : []).filter((e) => typeof e === "string"));
        const missing = eventTypes.filter((e) => !have.has(e));
        if (missing.length === 0)
            return [];
        await this.rest.request("PATCH", `/webhooks/subscriptions/${encodeURIComponent(subscriptionId)}`, { event_types: [...have, ...missing] }, { scope: "identity" });
        return missing;
    }
    /** The shared iMessage router: humans text `connect @handle` to this number. */
    async routerInfo() {
        const raw = await this.rest.request("GET", "/imessage/triage-number");
        return {
            number: str(raw.number) ?? "",
            connectCommand: str(raw.connect_command) ?? "",
            smsLink: str(raw.sms_link) ?? "",
            qrPngDataUrl: str(raw.connect_qr_png_data_url) ?? str(raw.qr_png_data_url) ?? "",
        };
    }
    /**
     * Dedicated iMessage pool: bind a recipient's phone to an identity and send the
     * opening text from one of the organization's pool numbers. The recipient never
     * has to text first. Admin key only. Until the recipient replies, nothing else
     * may be sent on that connection (Inkbox answers 409 imessage_awaiting_inbound).
     */
    async connectRecipient(input) {
        const text = input.firstMessage.trim();
        if (!text)
            throw new Error("connectRecipient: the first message is empty");
        if (text.length >= CONNECT_FIRST_MESSAGE_MAX)
            throw new Error(`connectRecipient: the first message must be under ${CONNECT_FIRST_MESSAGE_MAX} characters (got ${text.length})`);
        try {
            const raw = await this.rest.requestUrl("POST", `${this.rest.baseUrl}/api/v1/imessage/connect`, { agent_identity_id: input.identityId, recipient_number: input.recipientNumber, first_message: text }, { "Idempotency-Key": input.idempotencyKey });
            const assignment = raw.assignment && typeof raw.assignment === "object" ? raw.assignment : undefined;
            const message = raw.message && typeof raw.message === "object" ? raw.message : undefined;
            const out = { assignmentId: str(assignment?.id) ?? "", alreadyConnected: raw.already_connected === true };
            const conversationId = str(raw.conversation_id);
            if (conversationId)
                out.conversationId = conversationId;
            const messageId = str(message?.id);
            if (messageId)
                out.messageId = messageId;
            return out;
        }
        catch (err) {
            if (err instanceof InkboxHttpError)
                throw new InkboxConnectError(err.status, connectErrorCode(err.body), err.message);
            throw err;
        }
    }
    /** Stop routing a recipient to an identity on the pool. Already disconnected counts as done. */
    async disconnectRecipient(input) {
        try {
            const raw = await this.rest.requestUrl("POST", `${this.rest.baseUrl}/api/v1/imessage/disconnect`, { agent_identity_id: input.identityId, recipient_number: input.recipientNumber }, { "Idempotency-Key": input.idempotencyKey });
            const out = { disconnected: raw.disconnected !== false };
            const id = str(raw.assignment_id);
            if (id)
                out.assignmentId = id;
            return out;
        }
        catch (err) {
            if (err instanceof InkboxHttpError)
                throw new InkboxConnectError(err.status, connectErrorCode(err.body), err.message);
            throw err;
        }
    }
    async enableA2A(handle) {
        await this.rest.request("PUT", `/identities/${encodeURIComponent(handle)}/a2a/settings`, { enabled: true });
    }
    /**
     * Allow a peer agent to call this identity (and vice versa). A duplicate rule is fine.
     * Wire shape follows the SDK's A2AResource.addContactRule (dist/a2a/resource.js):
     * `{ action, match_type: "handle", match_target, direction }`. Keep them in step.
     */
    async addContactRule(handle, peerHandle, direction = "both") {
        try {
            await this.rest.request("POST", `/identities/${encodeURIComponent(handle)}/a2a/contact-rules`, {
                action: "allow",
                match_type: "handle",
                match_target: peerHandle.replace(/^@+/, ""),
                direction,
            });
        }
        catch (err) {
            if (isHttpStatus(err, 409)) {
                const rules = await this.rest.request("GET", `/identities/${encodeURIComponent(handle)}/a2a/contact-rules`);
                const target = peerHandle.replace(/^@+/, "").toLowerCase();
                const existing = rules.find((rule) => rule.match_type === "handle" && str(rule.match_target)?.toLowerCase() === target && rule.direction === direction);
                if (existing?.action === "allow")
                    return;
                throw new Error(`The existing A2A contact rule for @${target} does not allow ${direction} traffic. Review the rule before inviting this agent.`);
            }
            throw err;
        }
    }
    async createInvitation(input) {
        const body = { peer_agent_handles: input.peerHandles.map((h) => h.replace(/^@+/, "")) };
        if (input.recipientEmail)
            body.recipient_email = input.recipientEmail;
        if (input.expiresInSeconds)
            body.expires_in_seconds = input.expiresInSeconds;
        const raw = await this.rest.request("POST", "/a2a/invitations", body);
        const out = { id: str(raw.id) ?? "" };
        const url = str(raw.invitation_url);
        if (url)
            out.invitationUrl = url;
        const token = str(raw.invitation_token);
        if (token)
            out.invitationToken = token;
        const prompt = str(raw.agent_handoff_prompt);
        if (prompt)
            out.agentHandoffPrompt = prompt;
        return out;
    }
    /** Cascades to the mailbox, number and tunnel. Already gone counts as done. */
    async deleteIdentity(handle) {
        try {
            await this.rest.request("DELETE", `/identities/${encodeURIComponent(handle)}`);
        }
        catch (err) {
            if (isHttpStatus(err, 404))
                return;
            throw err;
        }
    }
}
//# sourceMappingURL=provisioner.js.map