# mav-console Dashboard

Custom React + Apache ECharts dashboard for Maverick local AI operations, homelab health, and client automation monitoring.

It uses Prometheus as the data source and keeps Grafana out of the visual layer.

## Current Role

MCC is the control center for local infrastructure, local AI runtime health, and client workflow automation. The home page shows workflow status, online agents, action queues, approvals, recent reports, and live execution readiness.

The SEO workflow panel reads from the Windows repo bridge, which exposes the SEO-Agents-App outputs to the Proxmox-hosted dashboard.

Current bridge endpoints:

- `GET /seo/status` - workflow status from `workflow_status.json` with markdown fallback.
- `GET /seo/actions` - parsed action queue and adapter readiness.
- `POST /seo/actions/approve` - approve an action before live execution.
- `POST /seo/actions/run` - run dry-run or approved live action.

The dashboard proxies these through:

- `GET /api/workflows/seo/status`
- `GET /api/workflows/seo/actions`
- `POST /api/workflows/seo/actions/approve`
- `POST /api/workflows/seo/actions/run`

## Local Development

```powershell
npm install
npm run dev -- --port 3010
```

Open:

```text
http://localhost:3010
```

## Production

```powershell
npm run build
$env:PROMETHEUS_URL='http://192.168.1.12:9090'
$env:LLAMA_SERVER_URL='http://192.168.1.10:8080'
npm start
```

The dashboard polls `LLAMA_SERVER_URL` through `/api/llm/status` and displays the currently loaded local model in the top bar and Local AI Core panel.

## Windows Repo Bridge

The bridge source is:

```text
ops/windows-bridge/mav-repo-bridge.mjs
```

The running Windows copy is:

```text
C:\llama-cpp-server\mav-repo-bridge.mjs
```

Expected local bridge URL:

```text
http://127.0.0.1:8790
```

Expected LAN bridge URL from Proxmox:

```text
http://192.168.1.10:8790
```

The bridge should point at:

```text
C:\Workspace\Active\SEO-Agents-App
```

## Deployment

The dashboard is intended to stay hosted on the Proxmox server.

Live URL:

```text
http://192.168.1.12:3010
```

Proxmox app path:

```text
/opt/homelab-noc-dashboard
```

## Container

```bash
docker compose up -d --build
```

The app listens on port `3010`.
