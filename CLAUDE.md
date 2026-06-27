# MCC Dashboard — Project Instructions

MCC is the central server for the Maverick / Grizzly stack. It runs on port 3000 (PM2),
serves the React dashboard, and handles all AI orchestration via `/api/*` routes.
Maverick Assistant (MCA, Vercel) proxies to MCC via Tailscale Funnel.

## Key Files

```
lib/
  chat.mjs         — ALL AI chat logic: handleChat, estimate handlers, build/ops orchestration
  config.mjs       — env vars: ragUrl, anthropicApiKey, openRouterUrl/ApiKey/Model, openAiBaseUrl, geminiApiKey, hcpDir, etc.
  prompts.mjs      — all LLM system prompts
  models.mjs       — provider primitives (anthropicChat/openRouterChat/openAiChat), callClaude(), callLocalModel(), callPiRpc()
  http.mjs         — sseWrite(), sendJson(), readJsonBody()
  state.mjs        — addLedgerRun()
  exec.mjs         — resolveSafePath, loadSkills, workspaceTree, runExecTool, persistStagedRun
  self-improve.mjs — triggerSelfImprove
  extract.mjs      — /api/extract-file PDF/DOCX handler
routes/
  build.mjs        — applyStagedRun, handleListDirs
  orchestrator.mjs — status/plan/brief/task-run handlers, buildDashboardContext
  seo.mjs          — getSeoWorkflowStatus, proxySeoActions
src/
  main.jsx                      — dashboard app shell, chat bar, routing
  pages/OrchestratorPage.jsx    — full chat window + EstimateConfirmBar component
  pages/SystemPages.jsx         — hardware/network/server panels
  pages/HomePage.jsx            — home dashboard
  lib/dashboardHelpers.js       — WORKFLOW_MODES, readFileText, MAX_FILE_BYTES
  lib/api.js                    — api() URL helper
```

## Workflow Modes (lib/chat.mjs `handleChat`)

| mode | handler | description |
|------|---------|-------------|
| `ask` | RAG → Claude direct (→ OpenRouter fallback) | General Q&A + estimate intent detection |
| `agent` | Maverick agent in grizzly-hcp (Claude direct via Mastra) | Read tools + write workflows |
| `build` | Claude director → Pi executor (`PI_MODEL`) → NIM QC | Agentic coding loop |
| `ops` | Claude orchestrator → ops tools (local Qwen executor → OpenRouter GLM fallback) | Email, docs, spreadsheets, agents |
| `claude-code` | Claude Code CLI session | Full filesystem access via Superpowers |
| `estimate-ready` | `spawnEstimatePipeline()` | Pre-structured line items → grizzly-hcp |

## Estimate Pipeline (as of 2026-06-23)

**No standalone ESTIMATE mode button.** Estimates are triggered conversationally in ASK mode.

### Flow
```
User scopes job in ASK mode
  → says "build it" / "go ahead" / any ESTIMATE_TRIGGERS phrase
  → handleEstimateFromAsk(): Haiku reads last 16 msgs via ESTIMATE_EXTRACT_SYSTEM
      → extracts agreed items with types: matched / adjusted / new
      → streams confirmation card + [ESTIMATE_READY]{items, customer}[/ESTIMATE_READY]
  → Frontend shows estimateConfirmBar; any further chat → handleEstimateEdit()
  → User confirms → POST /api/chat mode:'estimate-ready'
  → spawnEstimatePipeline() → spawns grizzly-hcp/src/automations/estimates/from-chat.ts
  → from-chat.ts creates HCP estimate → returns URL in chat
```

### Key functions in lib/chat.mjs
- `handleEstimateFromAsk(histMsgs, prompt, res, controller)` — Haiku extraction → `[ESTIMATE_READY]` block
- `handleEstimateEdit(pendingItems, pendingCustomer, editRequest, res, controller)` — Haiku edits item list
- `spawnEstimatePipeline({ lineItems, customerName, customerEmail, customerPhone }, res, controller)` — spawns from-chat.ts
- `buildEstimateSummary(extracted)` — formats the confirmation card text shown in chat

### Key prompts in lib/prompts.mjs
- `ESTIMATE_EXTRACT_SYSTEM` — Haiku prompt to extract agreed items from conversation history
- `ESTIMATE_EDIT_SYSTEM` — Haiku prompt to apply natural-language edits to item list
- `CLAUDE_ESTIMATE_FALLBACK_SYSTEM` — used when RAG is offline (scoping only, no pricing)

### hcpDir (config.mjs)
Points to the local grizzly-hcp repo. `from-chat.ts` is spawned via `child_process.spawn`
from that directory. Must be set in `.env` as `HCP_DIR`.

## Related Repos

- **grizzly-hcp** (`maverick-core-software/grizzly-hcp`) — HCP automation + estimate pipeline
  - `src/automations/estimates/from-chat.ts` — stdin JSON → HCP estimate URL
  - `src/hcp/estimates.ts` — all HCP API ops (searchCustomer, createEstimate, addLineItem, etc.)
  - `src/rag/price-book.ts` — matchLineItems() RAG semantic → CSV fuzzy fallback
- **maverick-assistant** (`maverick-core-software/maverick-assistant`) — employee chat UI (Vercel)
  - `src/main.jsx` — handleBuildEstimate(), estimateConfirmBar

## Session Notes

- All three repos must be selected at Claude Code web session creation for MCC to be clonable
- If MCC clone fails with "repository not authorized", start a fresh session with all 3 repos selected
- RAG API is at `http://192.168.1.12:8181` (LAN only, same network as CartersPC)
- MCC runs on CartersPC (Windows 11, i5-13600K, RTX 4060 Ti), managed by PM2
