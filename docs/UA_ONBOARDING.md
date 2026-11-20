# Onboarding Guide: Founder Synergy Agent Platform + Open Instinct

## Project Overview

| | Founder Synergy Agent Platform | Open Instinct |
|---|---|---|
| **Name** | `tanstack_start_ts` (package) | `open-instinct` |
| **Version** | — | `0.1.0` |
| **Description** | Multi-tenant agent platform with authenticated UI, billing, onboarding, and Supabase edge functions | Open-source personal agent for iMessage/SMS/email with its own microVM computer |
| **Location** | `/Users/makaveli/WebstormProjects/founder-synergy-agent-platform` | `/Users/makaveli/WebstormProjects/synergy-instinct` |
| **Git commit** | `4499fa5` | `2ff247be` |
| **Languages** | TypeScript, React | TypeScript |
| **Package manager** | bun | pnpm@10.6.1 |
| **Node requirement** | — | `>=22.19.0` |

## Architecture Layers

### Founder Synergy Agent Platform

| Layer | Description | Key Files |
|---|---|---|
| **Application shell** | Vite + TanStack Start app entry and root layout | `src/start.ts`, `src/routes/__root.tsx`, `netlify.toml` |
| **Authentication** | Auth context, authenticated layout wrapper, protected routes | `src/contexts/AuthContext.tsx`, `src/components/layout/AuthenticatedLayout.tsx` |
| **Authenticated routes** | Agent management, billing, onboarding, Hermes deployment | `src/routes/_authenticated/{agents,billing,onboarding,hermes,hermes-agents,route}.tsx` |
| **Public routes** | Landing, auth, beta join, confirm-email, reset-password | `src/routes/{index,auth,join-beta,confirm-email,reset-password,sassify}.tsx` |
| **UI components** | Radix UI primitives + custom agent components | `src/components/ui/*`, `src/components/agents/*`, `src/components/layout/*` |
| **Data layer** | Agent templates, Supabase client | `src/data/agent-templates.ts`, `src/integrations/supabase/client.ts` |
| **Edge functions (infra)** | Supabase functions for machine claiming, checkout, templates, webhooks | `supabase/functions/{claim-machine,delete-machine,create-checkout-session,create/delete/list-agent-templates,dodo-webhook,endorsely-track,sassify,sync-signup}/index.ts` |

### Open Instinct (monorepo, 15 packages)

| Layer | Package | Description |
|---|---|---|
| **CLI / entry** | `packages/cli` | `instinct` CLI — init, dev, deploy, connect, chat commands |
| **Agent process** | `packages/server` | The agent runtime (`/health`, `/chat`, `/schedules`, file tools, skills) |
| **Agent loop** | `packages/core` | Pi agent loop, policy engine, memory, scheduler, approvals, audit, principal |
| **Messaging** | `packages/inkbox` | iMessage, SMS, email, webhooks, agent-to-agent transport |
| **Desktop** | `packages/computer` | Maritime desktopd in VM, or hosted Computers MCP |
| **Apps / tools** | `packages/apps` | Composio Tool Router |
| **Contacts / trust** | `packages/network` | Contacts, tiers, grants, invitations, agent-to-agent tools |
| **Payments** | `packages/payments` | Stripe Link wallet — one-time cards the owner approves |
| **Gateway (multi-user)** | `packages/gateway` | Signup page, connect page, relay from Inkbox webhooks → Maritime agents |
| **Atomic mail** | `packages/atomicmail` | — |
| **Ample** | `packages/ample` | — |
| **Agent run** | `packages/agentrun` | SOP pipeline, tool tracing, nudge gates |
| **Postiz MCP** | `packages/postiz-mcp` | MCP wrapper around Postiz public API |
| **OWUI adapter** | `packages/owui-adapter` | Open WebUI adapter |
| **Context** | `packages/context` | — |

## Key File Map

### Founder Synergy Agent Platform

| File | Purpose |
|---|---|
| `src/start.ts` | Vite dev server / app entry |
| `src/routes/__root.tsx` | Root layout with AuthProvider |
| `src/contexts/AuthContext.tsx` | Auth state and Supabase client context |
| `src/components/layout/AuthenticatedLayout.tsx` | Sidebar + navigation for authenticated users (358 lines — refactored in latest commit) |
| `src/routes/_authenticated/agents.tsx` | Agent management page (383 lines — refactored in latest commit) |
| `src/routes/_authenticated/billing.tsx` | Billing page |
| `src/routes/_authenticated/onboarding.tsx` | User onboarding flow |
| `src/routes/_authenticated/hermes.tsx` / `hermes-agents.tsx` | Hermes agent deployment |
| `src/components/agents/HermesDeployPage.tsx` | Hermes deploy UI component |
| `src/components/agents/TemplateGallery.tsx` | Template gallery |
| `src/data/agent-templates.ts` | Agent template definitions |
| `supabase/functions/claim-machine/index.ts` | Deploy chokepoint — routes super_user→fly, standard_user→instinct (486 lines) |
| `supabase/functions/delete-machine/index.ts` | Teardown chokepoint — Fly machine→volume→DB or gateway DELETE (233 lines) |
| `supabase/functions/dodo-webhook/index.ts` | Payment webhook — credits user accounts (no signature verification yet) |
| `supabase/functions/create-checkout-session/index.ts` | Stripe checkout session creation |
| `netlify.toml` | Netlify build config — `bun run build`, publish `dist`, Node 22 |

### Open Instinct

| File | Purpose |
|---|---|
| `packages/cli/src/bin.js` | CLI entry point |
| `packages/cli/src/cli.ts` | CLI command dispatch (init, dev, deploy, connect, chat) |
| `packages/server/src/http.ts` | Agent HTTP server (`/health`, `/chat`, `/schedules`) |
| `packages/server/src/boot.ts` | Agent boot sequence |
| `packages/core/src/policy.ts` | Policy engine — seven trust tiers (owner, staff, partner, family, friend, contact, stranger) |
| `packages/core/src/principal.ts` | Principal / identity model |
| `packages/core/src/memory.ts` | Agent memory |
| `packages/core/src/scheduler.ts` | Scheduler |
| `packages/core/src/approvals.ts` | Approval gates before tool execution |
| `packages/core/src/audit.ts` | Audit logging |
| `packages/inkbox/src/provisioner.ts` | Inkbox identity provisioning |
| `packages/inkbox/src/signature.ts` | Webhook signature verification (HMAC-SHA256) |
| `packages/inkbox/src/events.ts` | Event handling |
| `packages/computer/src/desktopd.ts` | Maritime desktopd in VM |
| `packages/apps/src/composio.ts` | Composio Tool Router |
| `packages/payments/src/wallet.ts` | Stripe Link wallet |
| `packages/gateway/src/main.ts` | Gateway boot — reads env, starts server |
| `packages/gateway/src/server.ts` | Gateway HTTP routes (signup, connect, relay, webhooks, admin) |
| `packages/gateway/src/provision.ts` | Multi-step user provisioning (Inkbox → key → signing key → webhooks → Maritime) |
| `packages/gateway/src/relay.ts` | Webhook-to-Maritime relay with signature verification |
| `packages/gateway/src/validate.ts` | Signup input validation |
| `packages/gateway/src/pages.ts` | HTML rendering (landing, connect, pending, message) — **GITHUB_URL hardcoded here** |
| `deploy/Dockerfile.gateway` | Gateway Docker build |
| `deploy/docker-compose.yml` | Local compose for agent + gateway |

## Complexity Hotspots

These are files with high logic density, security sensitivity, or frequent change — approach carefully:

| File | Why it's a hotspot |
|---|---|
| `supabase/functions/claim-machine/index.ts` (486 lines) | Role-based provider routing, JWT validation, polling for provisioning completion — security chokepoint |
| `supabase/functions/delete-machine/index.ts` (233 lines) | Teardown orchestration across Fly + gateway + DB — data integrity risk |
| `supabase/functions/dodo-webhook/index.ts` | **No webhook signature verification** — financial correctness risk (free credits via forged webhook) |
| `src/components/layout/AuthenticatedLayout.tsx` (358 lines) | Recently refactored (latest commit `4499fa5`) — Supabase realtime subscriptions, machine count polling |
| `src/routes/_authenticated/agents.tsx` (383 lines) | Recently refactored in same commit — agent management UI |
| `packages/gateway/src/provision.ts` | 6-step provisioning with crash-resume semantics — must not create duplicate billed agents |
| `packages/gateway/src/relay.ts` | HMAC-SHA256 webhook verification, duplicate/delivery-receipt filtering, 3-attempt retry |
| `packages/core/src/policy.ts` | Seven trust tiers enforced before every tool call — authorization bypass risk |
| `packages/gateway/src/pages.ts` | User-controlled data injected into HTML — XSS risk if `escapeHtml` missed anywhere |

## Guided Tour

1. **Start at the README** — `synergy-instinct/README.md` explains the architecture: you text → Inkbox → gateway → Maritime microVM → Pi agent loop → Composio tools → Stripe Link payments.

2. **Read the trust model** — `synergy-instinct/docs/PERMISSIONS.md` and `PROTOCOL.md` explain the seven trust tiers enforced in code.

3. **CLI quick start** — `pnpm instinct init --name ... --phone ...` then `pnpm instinct dev` (laptop, no phone number) or `pnpm instinct deploy --image ...` (Maritime, one agent per person).

4. **Multi-user gateway** — `packages/gateway/README.md` — signup page provisions an identity + agent per person; deploy with Coolify or Docker.

5. **Platform routes** — `founder-synergy-agent-platform/src/routes/` — authenticated vs public routes, agent management, billing, onboarding.

6. **Edge functions** — `founder-synergy-agent-platform/supabase/functions/` — each is a standalone Deno HTTP handler; `claim-machine` and `delete-machine` are the deploy/teardown chokepoints.

7. **Deploy the gateway** — `deploy/Dockerfile.gateway` builds the full monorepo; runs `node packages/gateway/dist/main.js` on port 8787 with `/health` check.

## Notes

- The `founder-synergy-agent-platform` has no README.md at root.
- `synergy-instinct` uses `pnpm` workspaces with 15 packages; `packages/gateway` is the multi-user relay deployed to Coolify on `gateway.foundersynergy.network`.
- Two known issues were just fixed: (1) gateway deploy failing on prettier lint errors, (2) `GITHUB_URL` hardcoded to `mariagorskikh/open-instinct` instead of the `siliconecodelab-del/synergy-instinct` container registry (fix pushed as commit `b82babb`, awaiting Coolify redeploy).
- No test infrastructure exists for `founder-synergy-agent-platform` edge functions; `synergy-instinct` has Vitest tests across ~15 packages.
