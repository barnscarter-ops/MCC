# Maverick Workspace — System State

Single source of truth for how all three projects connect. Update this at the end of every session.

---

## Projects

| Project | Path | Repo |
|---|---|---|
| MCC Dashboard | `C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard` | github.com/barnscarter-ops/MCC — branch `main` |
| LLaMA Server | `C:\llama-cpp-server` | git — branch `main` |
| SEO Agents App | `C:\Workspace\Active\SEO-Agents-App` | git — separate repo |

---

## Active Model

| Setting | Value |
|---|---|
| Model | `Qwen_Qwen3-14B-Q4_K_L.gguf` (bartowski) |
| Quant | Q4_K_L |
| Context | 16384 |
| VRAM at load | ~11 GB / 16.4 GB (67%) |
| TG speed | ~29.4 t/s (hardware ceiling) |
| Workflow speed | ~20-22 t/s |
| Startup script | `C:\llama-cpp-server\start-qwen3-14b-bg.ps1` |

---

## Ports & Services

| Service | Port | Process | Notes |
|---|---|---|---|
| MCC Dashboard | 3000 | PM2 `mav-console` | Main UI |
| LLaMA Server | 8080 | `llama-server.exe` | Local Qwen model |
| MAV Bridge | 8790 | PM2 `mav-bridge` | HTTP server + Supabase poller for SEO workflow |
| Claude Code Proxy | 8765 | uvicorn Python | Routes Claude Code CLI — do NOT kill |
| RAG Server | 8181 (192.168.1.12) | External | ASK mode in MCC |
| Prometheus | 9090 (192.168.1.12) | External | Metrics |

---

## How the services connect

```
Browser / Vercel frontend
  → Tailscale Funnel (https://carterspc.tailf72e3f.ts.net)
    → server.mjs :3000
      → mav-bridge :8790   (SEO status/approval)
      → llama-server :8080  (BUILD/OPS local execution)
      → OpenAI API          (BUILD planner)
      → NIM API             (BUILD QC reviewer)
      → Gemini API          (REVIEW mode chat)
      → Prometheus :9090    (metrics proxy)

mav-bridge also polls Supabase every 30s:
  → seo_runs (status=approved) → executes facebook + GBP + website tasks
```

**Dead code to ignore:**
- `ops/windows-bridge/mav-repo-bridge.mjs` — old file-based bridge, never deployed, superseded by Supabase workflow
- `bgw-exporter/` — standalone Go Prometheus exporter for the BGW router, not part of MCC pipeline

---

## AI Routing (MCC)

| Mode | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| ASK | RAG server (192.168.1.12:8181) | — | — |
| BUILD | Claude Haiku plan (Anthropic) | Qwen local execute (2000 tok, 0.2°) | NIM llama-3.1-8b QC (400 tok) |
| OPS | Claude Haiku plan (Anthropic) | Qwen local execute (2000 tok, 0.2°) | NIM llama-3.1-8b QC (400 tok) |
| REVIEW | Gemini Flash (everyday chat only) | — | — |

**API keys — all in Windows user env AND `MCC/.env`:**
- `OPENAI_API_KEY` — GPT-4o (available, not currently in primary routing)
- `ANTHROPIC_API_KEY` — Claude Haiku planner
- `NVIDIA_NIM_API_KEY` — NIM QC reviewer
- `GEMINI_API_KEY` — Gemini chat (REVIEW mode)

---

## SEO Workflow (Supabase-based)

The mav-bridge is the executor. Flow:
1. SEO run created in `seo_runs` table with `status='pending_approval'`
2. MCC dashboard shows it — user approves → mav-bridge HTTP `POST /seo/actions/approve`
3. Bridge sets `status='approved'` in Supabase
4. mav-bridge poll loop picks it up, executes facebook + GBP + website tasks
5. Results written back to `weekly_posts` / `website_tasks` / `run_logs`

**Supabase tables:** `seo_runs`, `weekly_posts`, `website_tasks`, `run_logs`

mav-bridge HTTP endpoints (all on 127.0.0.1:8790):
- `GET /health` — liveness check
- `GET /seo/status` — run summary for MCC dashboard
- `GET /seo/actions` — pending approvals
- `POST /seo/actions/approve` — approve a run or task
- `POST /seo/actions/run` — trigger execution (live=true)

---

## PM2 Ecosystem (`ecosystem.config.cjs` in MCC root)

All services managed from one file. To apply env changes: `pm2 reload ecosystem.config.cjs`

| Name | Script | Env source |
|---|---|---|
| `mav-console` | `server.mjs` | `MCC/.env` (via dotenv in ecosystem) |
| `mav-bridge` | `SEO-Agents-App/scripts/mav-bridge.mjs` | `SEO-Agents-App/.env` (env_file) |
| `prometheus-sync` | `scripts/prometheus-sync.mjs` | `SEO-Agents-App/.env` (env_file) |
| `downloads-watcher` | `C:\Users\carte\DownloadsOrganizer\...` | none |

---

## End-of-Session Checklist

Run this before closing:

```powershell
# 1. Commit MCC dashboard
cd "C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard"
git add -p && git commit -m "session: <brief description>"

# 2. Commit SEO Agents App (if changed)
cd "C:\Workspace\Active\SEO-Agents-App"
git add -p && git commit -m "session: <brief description>"

# 3. Commit llama server (if changed)
cd "C:\llama-cpp-server"
git add -p && git commit -m "session: <brief description>"

# 4. Tell Claude to update memory
```

---

## Last Updated
2026-06-13 — Bridge HTTP server added to mav-bridge.mjs (port 8790). MAV_REPO_BRIDGE_URL, GEMINI_API_KEY, PROMETHEUS_URL added to MCC .env and ecosystem.config.cjs. WORKSPACE.md updated with full architecture map.
