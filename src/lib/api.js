import { PROM_QUERIES } from '../config/metrics.js';

// In production (Vercel), VITE_API_BASE points to the Tailscale Funnel URL of server.mjs.
// Locally, it's empty and relative /api/ paths hit the local server via Vite's dev proxy.
const API_BASE = import.meta.env.VITE_API_BASE || '';

export function api(path) {
  return `${API_BASE}${path}`;
}

function valueFromPrometheus(payload) {
  const result = payload?.data?.result;
  if (!Array.isArray(result) || result.length === 0) return null;
  const raw = result[0]?.value?.[1];
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

async function queryPrometheus(query) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(api(`/api/query?query=${encodeURIComponent(query)}`), {
      cache: 'no-store',
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`Prometheus query failed: ${response.status}`);
    return valueFromPrometheus(await response.json());
  } finally {
    clearTimeout(timeout);
  }
}

export async function queryAllMetrics() {
  const entries = Object.entries(PROM_QUERIES);
  const results = [];
  const concurrency = 4;
  for (let index = 0; index < entries.length; index += concurrency) {
    const batch = entries.slice(index, index + concurrency);
    const settled = await Promise.allSettled(
      batch.map(async ([key, query]) => [key, await queryPrometheus(query)])
    );
    settled.forEach((result, batchIndex) => {
      if (result.status === 'fulfilled') {
        results.push(result.value);
      } else {
        results.push([batch[batchIndex][0], null]);
      }
    });
  }
  return results;
}

export async function queryModelStatus() {
  const response = await fetch(api('/api/llm/status'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Model status failed: ${response.status}`);
  return response.json();
}

export async function queryDeployStatus() {
  const response = await fetch(api('/api/deploy/status'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Deploy status failed: ${response.status}`);
  return response.json();
}

export async function queryOrchestratorStatus() {
  const response = await fetch(api('/api/orchestrator/status'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Orchestrator status failed: ${response.status}`);
  return response.json();
}

export async function createOrchestratorPlan(idea) {
  const response = await fetch(api('/api/orchestrator/plan'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Plan failed: ${response.status}`);
  return payload;
}

export async function createLocalWorkerBrief(idea, task) {
  const response = await fetch(api('/api/orchestrator/local-brief'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea, task })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Worker brief failed: ${response.status}`);
  return payload;
}

export async function createTaskRun(idea, task, mode = 'brief') {
  const response = await fetch(api('/api/orchestrator/task-run'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ idea, task, mode })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Task run failed: ${response.status}`);
  return payload;
}

export async function updateTaskRun(id, patch) {
  const response = await fetch(api('/api/orchestrator/task-run'), {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ id, ...patch })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `Task update failed: ${response.status}`);
  return payload;
}

export async function queryMemory(query = '') {
  const suffix = query ? `?query=${encodeURIComponent(query)}` : '';
  const response = await fetch(api(`/api/memory${suffix}`), { cache: 'no-store' });
  if (!response.ok) throw new Error(`Memory query failed: ${response.status}`);
  return response.json();
}

export async function querySeoWorkflow() {
  const response = await fetch(api('/api/workflows/seo'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`SEO workflow failed: ${response.status}`);
  return response.json();
}

export async function querySeoActions() {
  const response = await fetch(api('/api/workflows/seo/actions'), { cache: 'no-store' });
  if (!response.ok) throw new Error(`SEO actions failed: ${response.status}`);
  return response.json();
}

export async function approveSeoAction(actionId, note = '') {
  const response = await fetch(api('/api/workflows/seo/actions/approve'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId, approvedBy: 'MCC', note })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `SEO approval failed: ${response.status}`);
  return payload;
}

export async function runSeoAction(actionId, live = false) {
  const response = await fetch(api('/api/workflows/seo/actions/run'), {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ actionId, live })
  });
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || `SEO action run failed: ${response.status}`);
  return payload;
}
