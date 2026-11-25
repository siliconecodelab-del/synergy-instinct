---
name: postiz
description: Schedule and manage social media posts across multiple platforms (X, LinkedIn, Instagram, Facebook, TikTok, YouTube, etc.) using a self-hosted Postiz instance connected via Composio (custom_postiz). Use when the user wants to schedule, draft, list, or delete social posts, or manage connected social channels.
---

# Postiz

Postiz is a self-hosted social media scheduling platform exposed to the agent through the `custom_postiz` Composio toolkit. It lets you schedule posts to many platforms from one place.

## When to use

- The user asks to schedule a post for a future date/time on one or more platforms.
- The user wants to draft, review, or delete scheduled posts.
- The user wants to list connected social channels or check posting status.
- The user wants to repurpose content into scheduled social posts.

## Prerequisites

- The gateway must have `POSTIZ_MCP_URL` configured and the wrapper must have booted (`postizReady`).
- The person must have saved their own Postiz API key on the connect page (per-person BYOK), so `custom_postiz` is in their toolkit list.
- If `custom_postiz` is not in the toolkit list, tell the user to save their Postiz API key on the connect page first.

## How to act

1. Use the Composio tools for `custom_postiz` (search via `COMPOSIO_SEARCH_TOOLS` in router mode, or the direct tool names in direct mode).
2. Always confirm the target platforms, content, and scheduled time with the user before creating a post.
3. Never schedule a post that publishes to a real audience without explicit approval from the owner.
4. When drafting, prefer saving as a draft first, then confirm before scheduling.
5. Report back the scheduled time, platforms, and post id after a successful create.

## Safety

- Posts reach real audiences. Treat every create/schedule action as a send that requires owner approval.
- Do not include secrets, API keys, or tokens in post content.
- If a post fails to schedule, surface the error and suggest retrying or checking the Postiz connection.
