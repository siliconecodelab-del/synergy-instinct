/**
 * Platform-team approvals. Separate from owner approvals: these gate changes
 * that affect ALL users (agent prompt changes, execution-mode routing, etc.).
 * Notifications go to Slack (and optionally Linear/email in the future).
 *
 * Storage: <state>/platform-approvals.json
 */
import { randomInt } from "node:crypto";
import type { StateDir } from "./state.js";

const FILE = "platform-approvals.json";
const TOKEN_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const TOKEN_LENGTH = 4;
const DEFAULT_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours (longer than owner approvals)

export interface PlatformApproval {
  id: string;
  token: string;
  createdAt: string;
  expiresAt: string;
  status: "pending" | "approved" | "denied" | "expired";
  requestedBy: string;
  summary: string;
  capability: string;
  target: "agent_prompt" | "sop_content" | "execution_mode";
  payload: Record<string, unknown>;
  channels: string[];
  notificationRefs: Record<string, string>;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface PlatformApprovalMatch {
  approval: PlatformApproval;
  approved: boolean;
  remainder: string;
}

export class PlatformApprovalStore {
  private readonly state: StateDir;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(state: StateDir, opts: { now?: () => Date; ttlMs?: number } = {}) {
    this.state = state;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  }

  private load(): PlatformApproval[] {
    const raw = this.state.readJson<unknown>(FILE, []);
    return Array.isArray(raw) ? (raw as PlatformApproval[]) : [];
  }

  private save(list: PlatformApproval[]): void {
    const cutoff = this.now().getTime() - 7 * 24 * 60 * 60 * 1000;
    const kept = list.filter((a) => a.status === "pending" || Date.parse(a.createdAt) >= cutoff);
    this.state.writeJson(FILE, kept);
  }

  private sweep(list: PlatformApproval[]): PlatformApproval[] {
    const t = this.now().getTime();
    let changed = false;
    for (const a of list) {
      if (a.status === "pending" && Date.parse(a.expiresAt) <= t) {
        a.status = "expired";
        changed = true;
      }
    }
    if (changed) this.save(list);
    return list;
  }

  private newToken(): string {
    let t = "";
    for (let i = 0; i < TOKEN_LENGTH; i++) t += TOKEN_ALPHABET[randomInt(TOKEN_ALPHABET.length)];
    return t;
  }

  create(input: Omit<PlatformApproval, "token" | "createdAt" | "expiresAt" | "status" | "channels" | "notificationRefs">): PlatformApproval {
    const list = this.sweep(this.load());
    const now = this.now();
    let token = this.newToken();
    while (list.some((a) => a.token === token && a.status === "pending")) token = this.newToken();
    const approval: PlatformApproval = {
      ...input,
      token,
      createdAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + this.ttlMs).toISOString(),
      status: "pending",
      channels: [],
      notificationRefs: {},
    };
    list.push(approval);
    this.save(list);
    return { ...approval };
  }

  get(token: string): PlatformApproval | undefined {
    const found = this.sweep(this.load()).find((a) => a.token === token.toUpperCase());
    return found ? { ...found } : undefined;
  }

  pending(): PlatformApproval[] {
    return this.sweep(this.load())
      .filter((a) => a.status === "pending")
      .map((a) => ({ ...a }));
  }

  resolve(token: string, approved: boolean, resolvedBy: string): PlatformApproval | undefined {
    const list = this.sweep(this.load());
    const a = list.find((x) => x.token === token.toUpperCase());
    if (!a || a.status !== "pending") return a ? { ...a } : undefined;
    a.status = approved ? "approved" : "denied";
    a.resolvedAt = this.now().toISOString();
    a.resolvedBy = resolvedBy;
    this.save(list);
    return { ...a };
  }

  markNotified(token: string, channel: string, ref: string): void {
    const list = this.load();
    const a = list.find((x) => x.token === token.toUpperCase());
    if (!a) return;
    a.channels.push(channel);
    a.notificationRefs[channel] = ref;
    this.save(list);
  }

  /** Find a platform approval by target and capability (searches all statuses). */
  findByTargetCapability(target: PlatformApproval["target"], capability: string): PlatformApproval | undefined {
    return this.load().find((a) => a.target === target && a.capability === capability);
  }

  /** The pending approval, if any, matching a given target. */
  findPendingByTarget(target: PlatformApproval["target"], capability?: string): PlatformApproval | undefined {
    return this.pending().find((a) => a.target === target && (!capability || a.capability === capability));
  }
}
