# Connect, reprovision and ready-agent reconnect: execution flow

This document explains the runtime flow of three gateway code paths that make a
person's saved connections (company brain, Postiz key, Oxygen OAuth) actually
reach their running agent:

- `handleConnectUpdate` — `POST /connect/<userId>` (the connect page form)
- `handleAdminReprovision` — `POST /api/admin/reprovision/<userId>`
- `provisionUser` ready-agent reconnect branch — `provisionUser` when the record
  is already `ready` with a `maritimeAgentId`

All three share the same goal: the gateway's store is the source of truth, but a
running/sleeping Maritime container keeps its own copy of the env and its own copy
of the files on its volume. Writing to the store alone never changes what the
agent sees. Each path therefore ends with either a files push, an env sync, or
both, and the env sync always ends with a container stop → start cycle (the only
reliable way to apply new env to a deployed container).

## 1. `handleConnectUpdate` — `POST /connect/<userId>`

**Source:** `packages/gateway/src/server.ts`, `handleConnectUpdate`.

**Trigger:** the connect page's Connections form (browser POST) or a JSON client
(`Accept: application/json`). Fields: `brainRepo`/`brain_repo`,
`brainToken`/`brain_token`, `postizKey`/`postiz_key`, `postizClear`/`postiz_clear`.

### Step-by-step

1. **Parse and validate the body.**
   - `parseBrainUpdate(body)` → `{ repo, token? }`. Empty repo clears the brain.
     A non-empty repo must normalize to `owner/repo`; an empty token keeps the
     saved one.
   - `parsePostizKeyUpdate(body)` → `{ key?, clear }`. Empty key keeps the saved
     one; `postizClear=on` removes it.
   - On any validation error the handler returns `400` (JSON or HTML message)
     **before** touching the store, so a bad form never partially saves.

2. **Build the next record in memory (no I/O yet).**
   - Start from a clone of the current `user`.
   - Brain:
     - if `repo` is empty: `delete next.brainRepo; delete next.brainToken;`
       (clearing the repo always clears the token).
     - else: `next.brainRepo = repo;` and, only if a new token was supplied,
       `next.brainToken = token;` (leaving the box blank keeps the saved token).
   - Postiz:
     - if `clear`: `delete next.postizKey; delete next.postizComposioAccountId;`
     - else if a new key: `next.postizKey = key; delete next.postizComposioAccountId;`
       (a new key invalidates the old connected account, so it is re-minted).
   - Log the save (`connect.brain_saved`, `connect.brain_cleared`,
     `connect.postiz_key_saved`, `connect.postiz_key_cleared`). Secrets are never
     logged.

3. **Persist first.** `next = opts.store.save(next);`
   The record changes before any slow work starts, so a retry is safe: re-posting
   the same form lands on the already-updated record.

4. **Background work (only if `next.maritimeAgentId` exists).** The handler
   returns `303`/`200` immediately; everything below runs in a detached async
   IIFE. A failure in any step is logged and never fails the request.

   a. **Brain push (only if `repo` was supplied).**
      `pushBrain(repo, next.brainToken, …)` walks the GitHub tree and writes text
      files under `/data/brain` on the agent's volume through the Maritime files
      API (`PUT /api/agents/<id>/files/write`). Uses the person's token, else the
      fleet `GITHUB_TOKEN`, else anonymous. Caps and skips are enforced in
      `pushBrain`. Success logs `connect.brain_pushed {written, skipped, bytes}`;
      failure logs `connect.brain_failed`.

   b. **Postiz account mint (only if a new key was supplied and
      `composio.postizReady`).**
      `composio.ensureAccount(handle, { toolkit: CUSTOM_POSTIZ, apiKey: key })`
      creates/reuses the connected account carrying that person's key. The
      returned id is saved on the record as `postizComposioAccountId`. Failure
      logs `connect.postiz_account_failed`.

   c. **Heal + env sync (always, for a ready agent).**
      - `healPostizAccount(store.get(next.id) ?? next, …)` reuses a still-active
        connected account, replaces a stale id, or mints a missing one from the
        saved key. This covers the case where the key predates account minting.
      - `syncAgentEnv(latest, envSyncDeps(latest))` recomputes the agent's full
        env from its template + current boot readiness and pushes only the
        differing keys to Maritime, then runs the container stop → start cycle so
        the new `COMPOSIO_TOOLKITS` (with or without `custom_postiz`) and any
        rotated key actually take effect. Failure logs `connect.env_sync_failed`.

5. **Respond.** `303` redirect back to the connect page (or `200 {ok, hasBrain,
   hasPostizKey}` for JSON clients). The response never waits for the background
   work above.

### Invariants

- The store is updated before any network call, so a crash mid-push leaves a
  correct record; the next connect-page visit or reprovision retries the push.
- A cleared brain (`repo === ""`) deletes both `brainRepo` and `brainToken`.
- A blank token box never overwrites a saved token.
- Secrets (`brainToken`, `postizKey`) are never echoed in responses, logs or
  rendered pages.

## 2. `handleAdminReprovision` — `POST /api/admin/reprovision/<userId>`

**Source:** `packages/gateway/src/server.ts`, `handleAdminReprovision`.

**Trigger:** operator call with `Authorization: Bearer <GATEWAY_ADMIN_TOKEN>`.
Used to heal a live agent without recreating it.

### Step-by-step

1. **Auth and lookup.**
   - `503` if `GATEWAY_ADMIN_TOKEN` is unset, `401` on a bad bearer, `404` for an
     unknown user, `409` if the agent is not provisioned yet.

2. **Heal before sync.** Both heals can add a toolkit id that must enter the env
   in the same call, so syncing first would push a stale list.
   - `healPostizAccount(user, { composio }, store, log)` — reuse-while-active,
     replace stale, mint missing. Returns the (possibly updated) record.
   - `healOxygenAccount(healedPostiz, { composio }, store, log)` — promote a
     completed-but-uncaptured OAuth dance (pending account that Composio reports
     `ACTIVE`, owned by this handle, toolkit `custom_oxygen`).

3. **Re-push the company brain (best effort).** If `healed.brainRepo` and
   `healed.maritimeAgentId` are set, `pushBrain` walks the GitHub tree again and
   rewrites the files under `/data/brain`. A failure is logged
   (`admin.brain_failed`) and never aborts the reprovision. This is what makes a
   repo added or changed after the first provision land on a live agent.

4. **Sync env.** `syncAgentEnv(healed, envSyncDeps(healed))`:
   - Recomputes the expected env from the template + current boot readiness flags
     (executor/oxygen/postiz).
   - Pushes only the keys that differ from Maritime's stored env (secrets always
     re-push, because Maritime masks them).
   - Runs stop → start so the container deploys from the updated store.
   - Returns `{synced, total, refreshed}`.

5. **Respond.** `{ok: true, synced, total, refreshed, postizAccountId,
   oxygenAccountId}`. `postizAccountId`/`oxygenAccountId` are `null` when the
   owner has no key/dance or Composio is off.

### Notes

- Nothing is recreated: identity, connected accounts and `maritimeAgentId` stay.
- The synced `COMPOSIO_TOOLKITS` is what the agent *should* build its session
  from. An already-booted agent still reads the toolkit list from
  `/data/config.json` until it is patched or reprovisioned (see
  `EXECUTOR-BRAIN.md` § "Agent-side toolkit list").

## 3. `provisionUser` ready-agent reconnect branch

**Source:** `packages/gateway/src/provision.ts`, `provisionUser`, the
`if (user.status === "ready" && user.maritimeAgentId)` block.

**Trigger:** `provisionUser` is called for a record that is already `ready`
(e.g. the same handle + phone re-submitting signup, a retry after an error, or a
lost connect page). `startProvisioning` in `server.ts` calls it for matching
signups.

### Step-by-step

1. **Short-circuit.** The record is returned as-is; identity, account and agent
   id are never recreated. No Inkbox or Maritime create calls happen.

2. **Re-push the company brain (fire-and-forget, best effort).** If
   `user.brainRepo` is set, `pushBrain` re-walks the GitHub tree and rewrites
   `/data/brain` through the Maritime files API. A failure logs
   `provision.brain_failed` and never fails the reconnect. This retries a push
   that failed earlier or applies a repo added after first provision.

3. **Heal Postiz (fire-and-forget).** `healPostizAccount(user, deps, store, log)`
   reuses a live connected account, replaces a stale id, or mints a missing one
   from the saved key.

4. **Heal Oxygen then sync env (fire-and-forget).**
   `healOxygenAccount(user, deps, store, log)` promotes a completed-but-uncaptured
   OAuth dance; its result is chained into `syncAgentEnv(next, deps)`, which
   pushes the env delta and bounces the container. Failure logs
   `provision.env_sync_failed`.

5. **Return** the ready record immediately (the heals/sync run in the
   background).

### Why fire-and-forget

A reconnect is a retry path: the caller (signup) is waiting for a `202`/redirect
and must not block on a slow GitHub walk or a Composio hiccup. The store stays
correct regardless; the next reconnect or reprovision retries.

## Shared helpers

- `pushBrain(repo, token, deps)` — `packages/gateway/src/brain.ts`. Walks the
  GitHub tree, enforces caps (200 files, 256 KB/file, 3 MB total), skips build
  and credential-shaped files, writes under `/data/brain`.
- `healPostizAccount` / `healOxygenAccount` — `packages/gateway/src/provision.ts`.
  Idempotent reuse/replace/mint and OAuth-dance promotion.
- `syncAgentEnv(user, deps)` — `packages/gateway/src/provision.ts`. Recomputes
  env, pushes differing keys, bounces the container.
- `envSyncDeps(user)` — `packages/gateway/src/server.ts`. Builds the
  `AgentEnvDeps` for one person from the gateway options + template.

## When each path runs

| Path | Trigger | Pushes brain | Heals Postiz/Oxygen | Syncs env | Bounces container |
|---|---|---|---|---|---|
| `handleConnectUpdate` | connect page form | yes (if repo supplied) | yes (reuse-while-active) | yes | yes |
| `handleAdminReprovision` | operator admin call | yes (if brainRepo set) | yes | yes | yes |
| `provisionUser` reconnect | ready record re-provisioned | yes (if brainRepo set) | yes | yes | yes |

Signup-time provisioning (`provisionUser` non-ready branch) pushes the brain once
at first provision and does not sync env afterward (the container is fresh). A
failure there is non-fatal; the connect page or a reconnect retries it.