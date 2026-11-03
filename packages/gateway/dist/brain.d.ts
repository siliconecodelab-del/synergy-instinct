import { type Logger } from "./logger.js";
/** Caps that keep one person's repo from filling an agent's disk or the files API. */
export declare const BRAIN_MAX_FILES = 200;
export declare const BRAIN_MAX_FILE_BYTES: number;
export declare const BRAIN_MAX_TOTAL_BYTES: number;
/** Where pushed brain files land inside the agent's persistent volume. */
export declare const BRAIN_ROOT = "/data/brain";
/**
 * Accept `owner/repo`, a github.com URL, or a URL with `/tree/<branch>` and
 * return the canonical `owner/repo`. Anything else returns undefined; callers
 * turn that into a form error rather than silently dropping the field.
 */
export declare function normalizeBrainRepo(raw: string | undefined): string | undefined;
/** A GitHub token: non-empty, no whitespace, bounded. Empty means "unset". */
export declare function normalizeBrainToken(raw: string | undefined): string | undefined;
export interface BrainPushDeps {
    /** Fetch GitHub (injectable for tests). */
    fetchImpl?: typeof fetch;
    /** The agent's files API: write one file under /data/brain. */
    write: (path: string, content: string) => Promise<void>;
    /** Fleet-wide GitHub token used when the person supplied none (public repos need no token at all). */
    githubToken?: string;
    logger?: Logger;
}
export interface BrainPushResult {
    written: number;
    skipped: number;
}
/**
 * Pull a GitHub repo's text files and write them into the agent's volume under
 * /data/brain, so the person's company knowledge is on disk at first boot.
 *
 * Public repos need no token; private ones use the person's own token (fleet
 * fallback token for the operator's own repos). Credential-shaped files and
 * binaries are never fetched. Caps (file count, per-file and total bytes) are
 * enforced while walking, so one huge repo cannot overrun the agent.
 */
export declare function pushBrain(repo: string, token: string | undefined, deps: BrainPushDeps): Promise<BrainPushResult>;
//# sourceMappingURL=brain.d.ts.map