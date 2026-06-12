# Maverick Workspace — System State

Single source of truth for how all three projects connect. Update this at the end of every session.

---

## Projects

| Project | Path | Repo |
|---|---|---|
| MCC Dashboard | `C:\Workspace\Active\homelab-noc-dashboard\homelab-noc-dashboard\homelab-noc-dashboard` | git — branch `codex/mcc-memory-layer` |
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
| MAV Bridge | 8790 | PM2 `mav-bridge` | Git ops + file I/O for SEO app |
| Claude Code Proxy | 8765 | uvicorn Python | Routes Claude Code CLI — do NOT kill |
| RAG Server | 8181 (192.168.1.12) | External | ASK mode in MCC |
| Prometheus | 9090 (192.168.1.12) | External | Metrics |

---

## AI Routing (MCC)

| Mode | Model | Notes |
|---|---|---|
| ASK | RAG server → 192.168.1.12:8181 | External RAG |
| BUILD | Qwen (plan) → Qwen (execute) → Gemini QC | Gemini QC is wrong — needs fixing |
| REVIEW | Gemini Flash | Gemini = everyday chat only per user intent |
| OPS | Qwen local | Always local |

**Gemini intent:** Everyday/quick chat ONLY. Not QC, not code review.
**Codex:** Wired as placeholder in UI — not yet implemented.
**Claude:** Wired as placeholder in UI — not yet implemented.

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

## Last Updated
2026-06-12 — Model switched Q6_K_L → Q4_K_L, ctx 32768 → 16384. Benchmarked and confirmed 29.4 t/s TG ceiling. 35B model deleted.
