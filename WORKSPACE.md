# Maverick Workspace — System State

Single source of truth for how all three projects connect. Update this at the end of every session.

---

## Projects

| Project | Path | Repo | Remote |
|---|---|---|---|
| MCC Dashboard | `C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard` | git — branch `main` | `github.com/barnscarter-ops/MCC` |
| LLaMA Server | `C:\llama-cpp-server` | git — branch `main` | (confirm on GitHub) |
| SEO Agents App | `C:\Workspace\Active\SEO-Agents-App` | git — separate repo | on GitHub |

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
| MAV Bridge | 8790 | PM2 `mav-bridge` | Git ops + file I/O for SEO app |
| Claude Code Proxy | 8765 | uvicorn Python | Routes Claude Code CLI — do NOT kill |
| RAG Server | 8181 (192.168.1.12) | External | ASK mode in MCC |
| Prometheus | 9090 (192.168.1.12) | External | Metrics |

---

## AI Routing (MCC)

| Mode | Step 1 | Step 2 | Step 3 |
|---|---|---|---|
| ASK | RAG server (192.168.1.12:8181) | — | — |
| BUILD | GPT-4o plan (600 tok, 0.3°) | Qwen local execute (2000 tok, 0.2°) | NIM Qwen2.5-Coder-32B QC (400 tok, 0.2°) |
| OPS | GPT-4o plan (600 tok, 0.3°) | Qwen local execute (2000 tok, 0.2°) | NIM Qwen2.5-Coder-32B QC (400 tok, 0.2°) |
| REVIEW | Gemini Flash (everyday chat only) | — | — |

**API keys (User-level Windows env vars):**
- `OPENAI_API_KEY` — GPT-4o planner
- `NVIDIA_NIM_API_KEY` — NIM QC reviewer
- `GEMINI_API_KEY` — Gemini chat (set separately if needed)

---

## End-of-Session Checklist

Run this before closing:

```powershell
# 1. Commit MCC dashboard
cd "C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard"
git add -p && git commit -m "session: <brief description>"

# 2. Commit llama server
cd "C:\llama-cpp-server"
git add -p && git commit -m "session: <brief description>"

# 3. Commit SEO Agents App (if changed)
cd "C:\Workspace\Active\SEO-Agents-App"
git add -p && git commit -m "session: <brief description>"

# 4. Tell Claude to update memory
```

---

## Vercel Deployment

| Setting | Value |
|---|---|
| Project | `homelab-noc-dashboard` |
| Project ID | `prj_cu8Im5rWsAhYJPQj8aaEWqdzCYuG` |
| Team | `barnscarter-ops-projects` (`team_PU4iVzo6aSfn8SG0BJYETfkc`) |
| Production URL | `homelab-noc-dashboard.vercel.app` |
| Deployment method | `vercel deploy --prod` from CartersPC (not auto-deploy) |
| Key env var | `VITE_API_BASE=https://carterspc.tailf72e3f.ts.net` (set in Vercel project settings) |

---

## Tailscale Funnel

| Setting | Value |
|---|---|
| URL | `https://carterspc.tailf72e3f.ts.net` |
| Target | CartersPC port 3000 (server.mjs / mav-console) |
| Status | Active — confirmed HTTP 200 on 2026-06-14 |
| CORS | Configured in server.mjs to allow Vercel origin |

---

## Known Issues (as of 2026-06-14)

- **MAV Bridge offline**: `mav-bridge` PM2 process runs `SEO-Agents-App/scripts/mav-bridge.mjs` on port 8790. Needs `SEO-Agents-App/.env` to be correctly populated. Check with `pm2 logs mav-bridge`.
- **SEO Pipeline FETCH FAILED**: Downstream of mav-bridge being offline. Will self-resolve once bridge is healthy.
- **Architecture complexity**: SEO status goes Vercel → Tailscale → server.mjs → mav-bridge → SEO-Agents-App (4 hops). Needs simplification audit.

---

## Pending Audit (next session — do locally)

All three repos need an end-to-end review to find duplicated logic, orphaned code, and unnecessary indirection introduced while rebuilding across scattered folders. Start from SEO-Agents-App and map what each service actually owns vs. proxies.

---

## Last Updated
2026-06-14 — MCC pushed to GitHub (barnscarter-ops/MCC, main). Vercel deployment restored with latest code. Tailscale Funnel confirmed active. MAV Bridge offline — needs local debugging. Full architecture audit planned for next local session.
