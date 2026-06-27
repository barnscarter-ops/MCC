# MCC Provider Migration — Failure Analysis & Fix (COMPLETED)

_Date: 2026-06-26 · Branch: `main` · Server: PM2 `mav-console`, port 3000_
_Status: **FIXED & VERIFIED LIVE.** All priority AI paths working._

## What the user asked

> "we are no longer using litellm at all. we are using api keys for codex, gemini and
> claude. openrouter for anything else. no more qwen local model usage at all."

Investigate why **everything except the SEO pipeline** was broken, prove the cause, and fix it.
Priority order: **Maverick agent → Ask Maverick → rest of Orchestrator → hardware/networking.**

## TL;DR

Two independent migrations had been applied half-way and left the stack wired to **dead
endpoints**:

1. **MCC** (`server.mjs` + `lib/*`) had been pointed at OpenRouter but with **broken URL
   construction** and **wrong model namespaces** → every non-SEO path 404'd or threw.
2. **The Maverick agent** (`grizzly-hcp/src/agent`) was still routed through the **LiteLLM
   proxy on the homelab** (`http://192.168.1.12:4000`), which is **not running** → every agent
   call failed with `ECONNREFUSED`.

The SEO/estimate pipeline kept working because it never touched either — it calls the **direct
Anthropic API** (`api.anthropic.com`, `x-api-key`) and spawns `grizzly-hcp`'s estimate script.

The fix implements the requested architecture cleanly: **direct API keys per provider** (Claude,
Gemini, OpenAI/Codex) with **OpenRouter as the catch-all** for the agent/build executor, review,
and fallbacks. **No LiteLLM, no local Qwen.**

---

## Proof of cause (reproduced live)

| Path | Before | Root cause |
|------|--------|-----------|
| **Maverick agent** (`mode:agent`) | streamed only `*Maverick thinking...*`, then DONE | agent → `http://192.168.1.12:4000/v1/responses` (LiteLLM) → `connect ECONNREFUSED 192.168.1.12:4000`. Forced by `MAVERICK_OPENAI_BASE_URL` in `grizzly-hcp/.env`. |
| **Ask Maverick** (`mode:ask`) | `[All backends offline — please try again]` | `new URL('/v1/...', llamaServerUrl)` dropped the `/api` path → 404; OpenAI-compat base had a double `/v1`; `callClaude` sent the Anthropic-native model id to OpenRouter → 400. |
| **Orchestrator** plan/brief/task | failed | same URL/model bugs via `callLocalModel` / `callClaude`. |
| **Hardware model panel** (`/api/llm/status`) | `{"state":"offline"}` | `GET /v1/models` against the mangled URL returned HTML → `res.json()` threw. |

The two MCC URL bugs and the model-namespace bug were the original three. The **LiteLLM
`ECONNREFUSED` was the real blocker for priority #1** (the agent), surfaced only by running
`src/agent/run.ts` directly.

---

## The architecture now in place

| Role | Provider | Where |
|------|----------|-------|
| Ask Maverick chat, orchestrator plan/brief/task, planner (`callClaude`/`callLocalModel`) | **Claude — direct Anthropic** (`x-api-key`) | `lib/models.mjs` `anthropicChat` |
| **Maverick agent** (`grizzly-hcp`) | **Claude — direct Anthropic** (Mastra `@ai-sdk/anthropic`) | `grizzly-hcp/src/agent/model-router.ts` (default path) |
| Agent/build **code executor** (replaces local Qwen) | **GLM 5.2 via OpenRouter** (`z-ai/glm-5.2`) | `lib/chat.mjs` `delegateWriteToExecutor` |
| REVIEW mode | **Gemini** direct (if key) else **OpenRouter** | `lib/chat.mjs` |
| Build/ops QC | **NIM** (primary) → **OpenRouter** fallback | `lib/chat.mjs` `reviewPiOutput` |
| OpenAI / Codex | **OpenAI direct** (`openAiChat`) — user supplies real key | `lib/models.mjs` |
| Everything-else fallback | **OpenRouter** | `openRouterChat` |
| SEO / estimate pipeline | **Claude direct + grizzly-hcp spawn** (unchanged) | `lib/chat.mjs` estimate handlers |

Provider primitives `anthropicChat` / `openRouterChat` / `openAiChat` in `lib/models.mjs` are the
single source of truth — one provider per role, explicit fallback, no path-prefix tricks.

---

## Files changed

**MCC**
- `lib/config.mjs` — dropped `llamaServerUrl`/`localModel`/`defaultChatModel`; added
  `openRouterUrl/ApiKey/Model/ExecutorModel`, `openAiModel`. `OPENROUTER_MODELS` kept for the UI.
- `lib/models.mjs` — added `anthropicChat`/`openRouterChat`/`openAiChat`; `callLocalModel`,
  `callClaude` → Claude direct w/ OpenRouter fallback; `callGpt4o` → OpenAI direct; removed dead
  `textFromLlamaResponse`.
- `lib/chat.mjs` — executor renamed `delegateWriteToQwen` → `delegateWriteToExecutor` (OpenRouter
  GLM); ASK fallback simplified to `callClaude`'s internal cascade; REVIEW + QC fallbacks →
  OpenRouter.
- `lib/llama-status.mjs` — model panel now probes Anthropic (`/v1/models`, `x-api-key`).
- `routes/orchestrator.mjs` — worker relabeled "Claude (Anthropic)"; dashboard probe → Anthropic.
- `server.mjs` — imports + `/api/llm/models` default + startup log → OpenRouter/Anthropic.
- `.env` — `OPENROUTER_API_KEY` (was mislabeled `OPENAI_API_KEY`); `OPENAI_API_KEY` placeholder
  for a real key; `OPENAI_BASE_URL=https://api.openai.com`.
- Deleted the one-off `scripts/*.py` patch scripts (string-replace hacks; risk of re-mangling).

**grizzly-hcp**
- `.env` — removed `MAVERICK_OPENAI_BASE_URL=http://192.168.1.12:4000` (LiteLLM). Router now
  falls through to direct Anthropic. `OPENAI_API_KEY` placeholder (was the LiteLLM master key).

---

## Verification (live, after `pm2 restart mav-console --update-env`)

| Check | Result |
|-------|--------|
| `GET /api/llm/status` | `{"state":"online","model":"claude-haiku-4-5-...","endpoint":"https://api.anthropic.com"}` |
| `POST /api/chat {mode:"ask"}` | `2+2 = 4.` (was "All backends offline") |
| `POST /api/chat {mode:"agent"}` | `Hey Carter, what are we working on?` (was empty) |
| `grizzly-hcp` agent direct | `data: Hey Carter — ...` `[DONE] {"success":true}` (was `ECONNREFUSED :4000`) |
| `POST /api/orchestrator/plan` | full Claude-generated 5-task plan |
| `GET /api/orchestrator/status` | worker "Claude (Anthropic)" online |
| `node --check` (all 6 edited MCC modules) | OK |

Hardware/networking panels are Prometheus-fed and independent of the model wiring; the model
panel (the only AI element on those pages) is now online.

---

## Remaining / follow-ups

- **User action:** put a real key in `OPENAI_API_KEY` (MCC `.env` and `grizzly-hcp/.env`) when
  Codex/OpenAI is needed. Until then, OpenAI-direct paths return an auth error — nothing else
  depends on it (Claude is the default everywhere).
- Changes are **uncommitted on `main`**. Recommend committing the migration + fix together.
