import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 3011);
const deployStartedAt = new Date().toISOString();
const prometheusUrl = process.env.PROMETHEUS_URL || 'http://192.168.1.12:9090';
const llamaServerUrl = process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080';
const localModel = process.env.LOCAL_MODEL || 'qwen3-14b';
const repoBridgeUrl = process.env.MAV_REPO_BRIDGE_URL || '';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_MODES = new Set(['review']); // Gemini = everyday chat only (REVIEW mode)
const openAiApiKey = process.env.OPENAI_API_KEY || '';
const nimApiKey = process.env.NVIDIA_NIM_API_KEY || '';
// qwen2.5-coder-32b was retired from the NIM catalog (HTTP 410) — keep this overridable
const nimModel = process.env.NIM_MODEL || 'qwen/qwen3.5-122b-a10b';
const dataDir = process.env.MAV_CONSOLE_DATA_DIR || path.join(__dirname, '.mav-console');
const ledgerFile = path.join(dataDir, 'task-runs.json');
const workspacePath = process.env.MAV_CONSOLE_WORKSPACE || __dirname;
const memoryPath = process.env.MAV_MEMORY_PATH || 'C:\\Users\\carte\\.claude\\projects\\memory';

const orchestratorState = {
  updatedAt: null,
  runs: []
};

const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

function send(res, status, body, contentType = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'content-type': contentType, 'cache-control': 'no-store' });
  res.end(body);
}

function sendJson(res, status, payload) {
  send(res, status, JSON.stringify(payload), 'application/json; charset=utf-8');
}

function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

function readLedger() {
  try {
    ensureDataDir();
    if (!fs.existsSync(ledgerFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Failed to read task ledger: ${error.message}`);
    return [];
  }
}

function writeLedger(runs) {
  ensureDataDir();
  fs.writeFileSync(ledgerFile, JSON.stringify(runs.slice(0, 100), null, 2));
}

function addLedgerRun(run) {
  const runs = [run, ...readLedger().filter((item) => item.id !== run.id)].slice(0, 100);
  writeLedger(runs);
  orchestratorState.updatedAt = run.updatedAt || run.finishedAt || run.startedAt || new Date().toISOString();
  return run;
}

function updateLedgerRun(id, patch) {
  const runs = readLedger();
  const index = runs.findIndex((run) => run.id === id);
  if (index === -1) return null;
  const updated = { ...runs[index], ...patch, updatedAt: new Date().toISOString() };
  runs[index] = updated;
  writeLedger(runs);
  orchestratorState.updatedAt = updated.updatedAt;
  return updated;
}

function parseMemoryFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = match[1];
  const body = match[2].trim();
  const metadata = {};
  let inMetadata = false;
  const parsed = {};
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.trim() === 'metadata:') {
      inMetadata = true;
      continue;
    }
    const keyValue = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) continue;
    const [, key, rawValue] = keyValue;
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (inMetadata && rawLine.startsWith('  ')) {
      metadata[key] = value;
    } else {
      inMetadata = false;
      parsed[key] = value;
    }
  }
  return { ...parsed, metadata, body };
}

function redactMemoryBody(body) {
  return body
    .replace(/(?:ssh|api[_ -]?key|private[_ -]?key|token|secret|credential|password|root|id_ed25519)[^\r\n]*/gi, '[redacted sensitive reference]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted ip]');
}

function loadMemoryIndex() {
  if (!fs.existsSync(memoryPath)) {
    return {
      sourcePath: memoryPath,
      state: 'missing',
      memories: [],
      warnings: [`Memory path not found: ${memoryPath}`],
      updatedAt: new Date().toISOString()
    };
  }

  const warnings = [];
  const files = fs.readdirSync(memoryPath)
    .filter((file) => file.toLowerCase().endsWith('.md'))
    .sort();
  const memories = files.flatMap((file) => {
    const sourcePath = path.join(memoryPath, file);
    try {
      const parsed = parseMemoryFrontmatter(fs.readFileSync(sourcePath, 'utf8'));
      if (!parsed?.name) {
        warnings.push(`Skipped ${file}: missing frontmatter name.`);
        return [];
      }
      const related = [...parsed.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]);
      const stat = fs.statSync(sourcePath);
      return [{
        id: parsed.name,
        description: parsed.description || '',
        type: parsed.metadata?.type || 'unknown',
        nodeType: parsed.metadata?.node_type || 'memory',
        originSessionId: parsed.metadata?.originSessionId || null,
        related,
        body: redactMemoryBody(parsed.body),
        sourcePath,
        updatedAt: stat.mtime.toISOString()
      }];
    } catch (error) {
      warnings.push(`Skipped ${file}: ${error.message}`);
      return [];
    }
  });
  const typeCounts = memories.reduce((counts, memory) => {
    counts[memory.type] = (counts[memory.type] || 0) + 1;
    return counts;
  }, {});
  return {
    sourcePath: memoryPath,
    state: 'online',
    count: memories.length,
    typeCounts,
    memories,
    warnings,
    updatedAt: new Date().toISOString()
  };
}

function searchMemory(query) {
  const index = loadMemoryIndex();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  if (!terms.length) return { ...index, results: index.memories.slice(0, 8) };
  const scored = index.memories.map((memory) => {
    const haystack = `${memory.id} ${memory.description} ${memory.type} ${memory.body}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { ...memory, score };
  }).filter((memory) => memory.score > 0);
  scored.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { ...index, results: scored.slice(0, 8) };
}

async function getMemoryIndex(query = '') {
  const local = query ? searchMemory(query) : loadMemoryIndex();
  if (local.state === 'online' || !repoBridgeUrl) return local;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const upstream = new URL('/memory', repoBridgeUrl);
    if (query) upstream.searchParams.set('query', query);
    const response = await fetch(upstream, {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const payload = await response.json();
    return {
      ...payload,
      source: 'repo-bridge',
      localWarning: local.warnings?.[0] || null
    };
  } catch (error) {
    return {
      ...local,
      source: 'local',
      warnings: [...(local.warnings || []), error.name === 'AbortError' ? 'Repo bridge memory timed out' : error.message]
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function getSeoWorkflowStatus() {
  if (!repoBridgeUrl) {
    return {
      state: 'not-configured',
      reports: [],
      faults: ['Repo bridge is not configured.'],
      updatedAt: new Date().toISOString()
    };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const response = await fetch(new URL('/seo/status', repoBridgeUrl), {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || `SEO workflow failed: ${response.status}`);
    }
    return { ...payload, source: 'repo-bridge' };
  } catch (error) {
    return {
      state: 'error',
      source: 'repo-bridge',
      reports: [],
      faults: [error.name === 'AbortError' ? 'SEO workflow query timed out' : error.message],
      updatedAt: new Date().toISOString()
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function callRepoBridge(pathname, { method = 'GET', body = null, timeoutMs = 180_000 } = {}) {
  if (!repoBridgeUrl) {
    throw new Error('Repo bridge is not configured.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(pathname, repoBridgeUrl), {
      method,
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(body ? { 'content-type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : null
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(payload?.error || `Repo bridge failed: ${response.status}`);
    }
    return { ...payload, source: 'repo-bridge' };
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'Repo bridge action timed out' : error.message);
  } finally {
    clearTimeout(timeout);
  }
}

async function proxySeoActions(req, res, action) {
  try {
    if (action === 'list') {
      sendJson(res, 200, await callRepoBridge('/seo/actions', { timeoutMs: 180_000 }));
      return;
    }
    const payload = await readJsonBody(req);
    if (action === 'approve') {
      sendJson(res, 200, await callRepoBridge('/seo/actions/approve', {
        method: 'POST',
        body: payload,
        timeoutMs: 180_000
      }));
      return;
    }
    if (action === 'run') {
      sendJson(res, 200, await callRepoBridge('/seo/actions/run', {
        method: 'POST',
        body: payload,
        timeoutMs: 600_000
      }));
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message, source: 'repo-bridge' });
  }
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 512_000) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

function textFromLlamaResponse(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const chunks = payload?.output?.flatMap((item) => item?.content || []) || [];
  return chunks.map((chunk) => chunk?.text || '').filter(Boolean).join('\n').trim();
}

async function callLocalModel(input, { maxOutputTokens = 1400 } = {}) {
  const response = await fetch(new URL('/v1/responses', llamaServerUrl), {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({
      model: localModel,
      input,
      max_output_tokens: maxOutputTokens,
      temperature: 0.15
    })
  });
  const payload = await response.json();
  if (!response.ok) {
    throw new Error(payload?.error?.message || `Local model failed: ${response.status}`);
  }
  return textFromLlamaResponse(payload);
}

function fallbackPlan(idea, rawText = '') {
  return {
    summary: rawText || `Build a scoped MVP for: ${idea}`,
    tasks: [
      {
        id: 'task-1',
        title: 'Scout existing workspace',
        worker: 'local-qwen',
        reason: 'Cheap, fast read-only inspection before edits.',
        status: 'ready'
      },
      {
        id: 'task-2',
        title: 'Review architecture and risk',
        worker: 'codex-review',
        reason: 'Save hosted usage for final judgment and edge cases.',
        status: 'queued'
      }
    ],
    verification: ['Run focused tests', 'Run build', 'Review diff before deployment']
  };
}

function parsePlan(idea, rawText) {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return fallbackPlan(idea, rawText);
  try {
    const parsed = JSON.parse(jsonMatch[0]);
    return {
      summary: parsed.summary || fallbackPlan(idea, rawText).summary,
      tasks: Array.isArray(parsed.tasks) ? parsed.tasks.slice(0, 8).map((task, index) => ({
        id: task.id || `task-${index + 1}`,
        title: task.title || `Task ${index + 1}`,
        worker: normalizeWorker(task.worker),
        reason: task.reason || 'Routed by local planner.',
        status: task.status || 'queued'
      })) : fallbackPlan(idea, rawText).tasks,
      verification: Array.isArray(parsed.verification) ? parsed.verification.slice(0, 6) : fallbackPlan(idea, rawText).verification
    };
  } catch {
    return fallbackPlan(idea, rawText);
  }
}

function workerIds() {
  return ['local-qwen', 'repo-bridge', 'codex-review', 'claude-cli', 'rag-server'];
}

function normalizeWorker(worker) {
  return workerIds().includes(worker) ? worker : 'local-qwen';
}

async function getRepoBridgeState() {
  if (!repoBridgeUrl) {
    return { endpoint: null, state: 'not-configured' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(new URL('/health', repoBridgeUrl), {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const payload = await response.json();
    return {
      endpoint: repoBridgeUrl,
      state: response.ok && payload?.state === 'online' ? 'bridge-online' : 'bridge-error',
      detail: payload?.defaultRepo || null
    };
  } catch (error) {
    return {
      endpoint: repoBridgeUrl,
      state: 'bridge-offline',
      detail: error.name === 'AbortError' ? 'health timed out' : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function proxyPrometheus(req, res, url) {
  const query = url.searchParams.get('query');
  if (!query) {
    send(res, 400, JSON.stringify({ error: 'Missing query parameter' }), 'application/json; charset=utf-8');
    return;
  }
  const upstream = new URL('/api/v1/query', prometheusUrl);
  upstream.searchParams.set('query', query);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(upstream, { signal: controller.signal });
    const text = await response.text();
    send(res, response.status, text, response.headers.get('content-type') || 'application/json; charset=utf-8');
  } catch (error) {
    send(
      res,
      200,
      JSON.stringify({
        status: 'success',
        data: { resultType: 'vector', result: [] },
        warning: error.name === 'AbortError' ? 'Prometheus query timed out' : error.message
      }),
      'application/json; charset=utf-8'
    );
  } finally {
    clearTimeout(timeout);
  }
}

async function getLlamaStatus(res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  let modelData = null;
  let modelState = 'offline';
  let modelError = null;
  try {
    const response = await fetch(new URL('/v1/models', llamaServerUrl), {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const payload = await response.json();
    modelData = payload?.data?.[0] || payload?.models?.[0] || null;
    modelState = response.ok && modelData ? 'online' : 'error';
    modelError = response.ok ? null : `llama-server status returned ${response.status}`;
  } catch (error) {
    modelState = 'offline';
    modelError = error.name === 'AbortError' ? 'llama-server status timed out' : error.message;
  } finally {
    clearTimeout(timeout);
  }

  let evalSpeed = null;
  let promptTokensTotal = null;
  let outputTokensTotal = null;
  let genSpeed = null;
  let promptMetricsSource = 'unavailable';
  let promptMetricsError = 'llama.cpp runtime metrics are not exposed';

  function readPrometheusMetric(text, names) {
    for (const name of names) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const match = text.match(new RegExp(`^${escapedName}(?:\\{[^}]*\\})?\\s+([0-9eE.+-]+)`, 'm'));
      if (match) {
        const value = Number(match[1]);
        if (Number.isFinite(value)) return value;
      }
    }
    return null;
  }

  try {
    const promController = new AbortController();
    const promTimeout = setTimeout(() => promController.abort(), 1500);
    let promText = null;
    try {
      const promResponse = await fetch(new URL('/metrics', llamaServerUrl), {
        signal: promController.signal,
        headers: { accept: 'text/plain' }
      });
      if (promResponse.ok) {
        promText = await promResponse.text();
      } else {
        promptMetricsError = `/metrics returned ${promResponse.status}; falling back to /api/ps`;
      }
    } finally {
      clearTimeout(promTimeout);
    }

    if (promText) {
      const promptSecondsTotal = readPrometheusMetric(promText, [
        'llamacpp:prompt_seconds_total',
        'llamacpp_prompt_seconds_total',
        'llama_prompt_seconds_total'
      ]);
      const generatedSecondsTotal = readPrometheusMetric(promText, [
        'llamacpp:tokens_predicted_seconds_total',
        'llamacpp:tokens_generated_seconds_total',
        'llamacpp_tokens_predicted_seconds_total',
        'llamacpp_tokens_generated_seconds_total',
        'llama_tokens_predicted_seconds_total',
        'llama_tokens_generated_seconds_total'
      ]);
      const promptTokensPerSecond = readPrometheusMetric(promText, [
        'llamacpp:prompt_tokens_seconds',
        'llamacpp_prompt_tokens_seconds',
        'llama_prompt_tokens_seconds'
      ]);
      const predictedTokensPerSecond = readPrometheusMetric(promText, [
        'llamacpp:predicted_tokens_seconds',
        'llamacpp_predicted_tokens_seconds',
        'llama_predicted_tokens_seconds'
      ]);
      promptTokensTotal = readPrometheusMetric(promText, [
        'llamacpp:prompt_tokens_total',
        'llamacpp_prompt_tokens_total',
        'llama_prompt_tokens_total'
      ]);
      outputTokensTotal = readPrometheusMetric(promText, [
        'llamacpp:tokens_predicted_total',
        'llamacpp:tokens_generated_total',
        'llamacpp_tokens_predicted_total',
        'llamacpp_tokens_generated_total',
        'llama_tokens_predicted_total',
        'llama_tokens_generated_total'
      ]);
      evalSpeed = promptTokensPerSecond != null
        ? Math.round(promptTokensPerSecond * 10) / 10
        : promptSecondsTotal > 0 && promptTokensTotal > 0
        ? Math.round((promptTokensTotal / promptSecondsTotal) * 10) / 10
        : null;
      genSpeed = predictedTokensPerSecond != null
        ? Math.round(predictedTokensPerSecond * 10) / 10
        : generatedSecondsTotal > 0 && outputTokensTotal > 0
        ? Math.round((outputTokensTotal / generatedSecondsTotal) * 10) / 10
        : null;
      promptMetricsSource = 'llama-prometheus';
      promptMetricsError = promptTokensTotal == null && outputTokensTotal == null
        ? 'Prometheus endpoint is live, but token counters were not found'
        : null;
    } else {
      const psController = new AbortController();
      const psTimeout = setTimeout(() => psController.abort(), 1500);
      let psPayload = null;
      try {
        const psResponse = await fetch(new URL('/api/ps', llamaServerUrl), {
          signal: psController.signal,
          headers: { accept: 'application/json' }
        });
        if (psResponse.ok) {
          psPayload = await psResponse.json();
        } else {
          promptMetricsError = `/api/ps returned ${psResponse.status}`;
        }
      } finally {
        clearTimeout(psTimeout);
      }
      if (psPayload) {
        const modelId = modelData?.id || modelData?.name || '';
        const models = psPayload?.models;
        if (Array.isArray(models)) {
          const m = models.find((mm) => mm?.model === modelId || mm?.model?.endsWith(modelId.split('/').pop())) || models[0];
          if (m) {
            evalSpeed = m.prompt_eval_count && m.prompt_eval_duration ? Math.round((m.prompt_eval_count / (m.prompt_eval_duration / 1000)) * 10) / 10 : null;
            genSpeed = m.eval_count && m.eval_duration ? Math.round((m.eval_count / (m.eval_duration / 1000)) * 10) / 10 : null;
            promptTokensTotal = m.prompt_eval_count ?? null;
            outputTokensTotal = m.eval_count ?? null;
            promptMetricsSource = 'llama-api-ps';
            promptMetricsError = null;
          }
        }
      }
    }
  } catch (metricsError) {
    promptMetricsError = metricsError.name === 'AbortError' ? 'metrics query timed out' : metricsError.message;
  }

  send(
    res,
    200,
    JSON.stringify({
      state: modelState,
      model: modelData?.id || modelData?.name || modelData?.model || null,
      contextTokens: modelData?.meta?.n_ctx ?? null,
      parameterCount: modelData?.meta?.n_params ?? null,
      endpoint: llamaServerUrl,
      evalSpeed,
      promptTokensTotal,
      outputTokensTotal,
      genSpeed,
      promptMetricsSource,
      promptMetricsError,
      error: modelError
    }),
    'application/json; charset=utf-8'
  );
}

async function getOrchestratorStatus(res) {
  const repoBridgeState = await getRepoBridgeState();
  const memoryIndex = await getMemoryIndex();
  const taskRuns = readLedger();
  sendJson(res, 200, {
    updatedAt: orchestratorState.updatedAt,
    workers: [
      {
        id: 'local-qwen',
        label: 'Cline/Qwen Local',
        role: 'fast planner and coding brief',
        cost: 'local',
        endpoint: llamaServerUrl,
        state: 'online-check-via-model-panel'
      },
      {
        id: 'repo-bridge',
        label: 'Windows Repo Bridge',
        role: 'git diff, status, and worker audit',
        cost: 'local',
        endpoint: repoBridgeState.endpoint,
        state: repoBridgeState.state,
        detail: repoBridgeState.detail
      },
      {
        id: 'codex-review',
        label: 'Codex Hosted',
        role: 'architecture and quality review',
        cost: 'metered',
        state: 'manual-gated'
      },
      {
        id: 'claude-cli',
        label: 'Claude CLI',
        role: 'specialist implementation pass',
        cost: 'subscription-gated',
        state: 'manual-gated'
      },
      {
        id: 'rag-server',
        label: 'MCC Memory',
        role: 'project memory and retrieval',
        cost: 'local-network',
        state: memoryIndex.state,
        detail: `${memoryIndex.count || 0} memories`
      }
    ],
    runs: orchestratorState.runs,
    taskRuns
  });
}

async function createOrchestratorPlan(req, res) {
  try {
    const { idea } = await readJsonBody(req);
    if (!idea || typeof idea !== 'string' || idea.trim().length < 8) {
      sendJson(res, 400, { error: 'Idea must be at least 8 characters.' });
      return;
    }
    const prompt = `You are mav-console's local AI work router. Turn this product idea into a conservative implementation plan.

Idea:
${idea.trim()}

Return only JSON with this shape:
{
  "summary": "one sentence",
  "tasks": [
    { "id": "task-1", "title": "short action", "worker": "local-qwen|codex-review|claude-cli|rag-server", "reason": "why this worker", "status": "ready|queued" }
  ],
  "verification": ["short verification step"]
}

Rules:
- Route planning, coding briefs, and implementation to local-qwen.
- Route architecture review and quality checks to codex-review.
- Use claude-cli only for a specialist implementation pass.
- Use rag-server only when project memory or prior context matters.
- Keep the plan to 3-6 tasks.`;
    const rawText = await callLocalModel(prompt);
    const plan = parsePlan(idea.trim(), rawText);
    const run = {
      id: `run-${Date.now()}`,
      idea: idea.trim(),
      plan,
      rawText,
      createdAt: new Date().toISOString(),
      status: 'planned'
    };
    orchestratorState.updatedAt = run.createdAt;
    orchestratorState.runs = [run, ...orchestratorState.runs].slice(0, 8);
    sendJson(res, 200, run);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function createLocalWorkerBrief(req, res) {
  try {
    const { idea, task } = await readJsonBody(req);
    if (!idea || !task?.title) {
      sendJson(res, 400, { error: 'Idea and task.title are required.' });
      return;
    }
    const prompt = `You are the local Qwen coding worker inside mav-console.

Product idea:
${idea}

Assigned task:
${task.title}

Return a compact execution brief with:
1. Files likely needed
2. Commands to inspect first
3. Minimal edit plan
4. Verification command

Do not claim you changed files.`;
    const brief = await callLocalModel(prompt, { maxOutputTokens: 900 });
    sendJson(res, 200, { brief, createdAt: new Date().toISOString() });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function extractChangedFiles(output) {
  const files = new Set();
  const section = output.match(/(?:Files changed|Changed files|Files modified):?\s*([\s\S]{0,800})/i)?.[1];
  if (!section) return [];
  for (const match of section.matchAll(/`([^`]+\.(?:js|jsx|ts|tsx|css|mjs|json|md|yml|yaml|go))`/gi)) files.add(match[1]);
  for (const match of section.matchAll(/\b(src\/[^\s,;:)]+|server\.mjs|docker-compose\.yml|prometheus\.yml|Dockerfile)\b/g)) files.add(match[1]);
  return [...files].slice(0, 12);
}

async function createTaskRun(req, res) {
  const startedAt = new Date().toISOString();
  let ledgerRun = null;
  try {
    const { idea, task, mode = 'brief' } = await readJsonBody(req);
    if (!idea || !task?.title) {
      sendJson(res, 400, { error: 'Idea and task.title are required.' });
      return;
    }
    const worker = normalizeWorker(task.worker);
    ledgerRun = addLedgerRun({
      id: `taskrun-${Date.now()}`,
      planTaskId: task.id || null,
      idea,
      taskTitle: task.title,
      worker,
      mode,
      status: 'running',
      reviewStatus: 'needs-review',
      deployStatus: 'not-deployed',
      startedAt,
      updatedAt: startedAt,
      finishedAt: null,
      output: '',
      stderr: '',
      changedFiles: [],
      diffStat: '',
      diff: '',
      repoPath: workspacePath,
      repoBefore: null,
      repoAfter: null,
      repoBaselineDirty: false,
      allChangedFiles: [],
      verification: [],
      error: null
    });

    let output = '';
    let stderr = '';
    let durationMs = null;
    if (worker === 'local-qwen') {
      const prompt = `You are the local Qwen coding worker inside mav-console.

Product idea:
${idea}

Assigned task:
${task.title}

Return a compact execution brief with likely files, inspection commands, minimal edit plan, verification commands, and risks.

Do not claim you changed files.`;
      output = await callLocalModel(prompt, { maxOutputTokens: 900 });
    } else {
      output = `${workerLabelForServer(worker)} is not automated yet. Route this through manual review or a local worker.`;
    }

    const finishedAt = new Date().toISOString();
    const updated = updateLedgerRun(ledgerRun.id, {
      status: 'needs-review',
      output,
      stderr,
      durationMs,
      repoPath: ledgerRun.repoPath,
      repoBefore: ledgerRun.repoBefore,
      repoAfter: ledgerRun.repoAfter,
      repoBaselineDirty: ledgerRun.repoBaselineDirty,
      allChangedFiles: ledgerRun.allChangedFiles,
      changedFiles: ledgerRun.changedFiles.length ? ledgerRun.changedFiles : extractChangedFiles(output),
      diffStat: ledgerRun.diffStat,
      diff: ledgerRun.diff,
      verification: ledgerRun.verification,
      finishedAt
    });
    sendJson(res, 200, updated);
  } catch (error) {
    if (ledgerRun) {
      const failed = updateLedgerRun(ledgerRun.id, {
        status: 'failed',
        error: error.message,
        finishedAt: new Date().toISOString()
      });
      sendJson(res, 200, failed);
      return;
    }
    sendJson(res, 500, { error: error.message });
  }
}

function workerLabelForServer(worker) {
  const labels = {
    'local-qwen': 'Local Qwen',
    'repo-bridge': 'Repo Bridge',
    'codex-review': 'Codex Review',
    'claude-cli': 'Claude CLI',
    'rag-server': 'RAG Server'
  };
  return labels[worker] || worker;
}

async function updateTaskRun(req, res) {
  try {
    const { id, reviewStatus, deployStatus, status } = await readJsonBody(req);
    if (!id) {
      sendJson(res, 400, { error: 'Task run id is required.' });
      return;
    }
    const patch = {};
    if (['needs-review', 'approved', 'rejected'].includes(reviewStatus)) patch.reviewStatus = reviewStatus;
    if (['not-deployed', 'ready', 'deployed', 'blocked'].includes(deployStatus)) patch.deployStatus = deployStatus;
    if (['running', 'needs-review', 'approved', 'failed', 'deployed'].includes(status)) patch.status = status;
    const updated = updateLedgerRun(id, patch);
    if (!updated) {
      sendJson(res, 404, { error: 'Task run not found.' });
      return;
    }
    sendJson(res, 200, updated);
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function buildDashboardContext() {
  const lines = [
    `DATE/TIME: ${new Date().toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' })}`
  ];

  // Local model — quick probe, 1.5s timeout
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 1500);
    const r = await fetch(new URL('/v1/models', llamaServerUrl), { signal: ctrl.signal });
    clearTimeout(t);
    const payload = await r.json();
    const modelId = payload?.data?.[0]?.id || payload?.models?.[0]?.id || 'unknown';
    lines.push(`LOCAL MODEL: ${r.ok ? 'ONLINE' : 'ERROR'} | ${modelId}`);
  } catch {
    lines.push('LOCAL MODEL: OFFLINE');
  }

  // Active orchestrator plan (in-memory, sync)
  const runs = orchestratorState.runs || [];
  if (runs.length > 0) {
    const latest = runs[0];
    const taskCount = latest.plan?.tasks?.length || 0;
    const doneCount = latest.plan?.tasks?.filter(t => t.status === 'done' || t.status === 'complete').length || 0;
    lines.push(`ACTIVE PLAN: "${latest.plan?.summary || latest.idea || 'unnamed'}" | ${doneCount}/${taskCount} tasks done`);
  } else {
    lines.push('ACTIVE PLAN: none');
  }

  // Recent task runs from ledger (sync read)
  try {
    const taskRuns = readLedger();
    if (taskRuns.length > 0) {
      const recent = taskRuns.slice(0, 3).map(t => `${t.taskTitle} [${t.status}]`).join(' | ');
      lines.push(`RECENT TASKS: ${recent}`);
    }
  } catch {}

  return lines.join('\n');
}

function sseWrite(res, text) {
  if (!res.writable) return;
  res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
}

async function streamUpstream(upstream, onToken) {
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let collected = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const raw = line.slice(6).trim();
        if (raw === '[DONE]') continue;
        try {
          const tok = JSON.parse(raw);
          const delta = tok.choices?.[0]?.delta?.content || '';
          if (delta) { collected += delta; onToken(delta); }
        } catch {}
      }
    }
  } finally {
    reader.releaseLock();
  }
  return collected;
}

// ---------- BUILD pipeline: staged file changes + executor tools ----------

const stagingRoot = path.join(__dirname, 'tmp', 'build-staging');
const backupRoot = path.join(__dirname, 'tmp', 'build-backup');
const BLOCKED_REL = /^(\.env|\.git(\/|$)|node_modules(\/|$)|package-lock\.json$|tmp(\/|$)|\.mav-console(\/|$))/i;

function safeRelPath(rel) {
  if (!rel || typeof rel !== 'string') return null;
  const norm = path.normalize(rel.trim()).replace(/^[/\\]+/, '');
  if (path.isAbsolute(norm) || norm.split(/[/\\]/).includes('..')) return null;
  if (BLOCKED_REL.test(norm.replace(/\\/g, '/'))) return null;
  return norm;
}

function workspaceTree() {
  const lines = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'tmp', '.mav-console', '.venv']);
  const walk = (dir, prefix, depth) => {
    if (depth > 2 || lines.length >= 80) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name) || lines.length >= 80) continue;
      lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/', depth + 1);
    }
  };
  walk(workspacePath, '', 0);
  return lines.join('\n');
}

const EXEC_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'List files in a workspace directory (non-recursive). Directories end with /.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Relative directory path; "." for workspace root.' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file from the workspace. Returns up to 6000 characters per call; use offset to continue.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number', description: 'Character offset to start from (default 0).' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Stage a new version of a file for human review (nothing is written to the workspace directly). Content MUST be the complete file, never a fragment or snippet.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run an allowlisted terminal command in the workspace root. Allowed: "node --check <file>", "node -v", "npm run build", "npm test", "npx vitest run [args]", "git status|diff|log [args]". No shell operators (| ; && > etc). NOTE: commands see the REAL workspace — your staged write_file changes are NOT included until the human applies them.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } }
];

const ALLOWED_COMMANDS = [
  /^node --check [\w./\\-]+$/,
  /^node -v$/,
  /^npm run build$/,
  /^npm test(\s|$)/,
  /^npx vitest run(\s|$)/,
  /^git (status|diff|log)(\s|$)/
];

function runShellCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: workspacePath });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, 120_000);
    child.stdout.on('data', (d) => { if (out.length < 8000) out += d; });
    child.stderr.on('data', (d) => { if (out.length < 8000) out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`exit code: ${code}${killed ? ' (killed after 120s)' : ''}\n${out.slice(0, 6000) || '(no output)'}`);
    });
    child.on('error', (err) => { clearTimeout(timer); resolve(`ERROR: ${err.message}`); });
  });
}

async function runExecTool(name, args, staged) {
  if (name === 'run_command') {
    const cmd = String(args.command || '').trim();
    if (/[;&|<>`$^%]/.test(cmd)) return 'ERROR: shell operators are not allowed';
    if (!ALLOWED_COMMANDS.some((re) => re.test(cmd))) {
      return 'ERROR: command not on the allowlist. Allowed: node --check <file>, node -v, npm run build, npm test, npx vitest run, git status/diff/log.';
    }
    return runShellCommand(cmd);
  }
  if (name === 'list_dir') {
    const rel = safeRelPath(args.path || '.');
    if (rel === null) return 'ERROR: path not allowed';
    try {
      const entries = fs.readdirSync(path.join(workspacePath, rel), { withFileTypes: true });
      return entries
        .filter((e) => !['node_modules', '.git', 'dist', 'tmp', '.mav-console'].includes(e.name))
        .slice(0, 100)
        .map((e) => e.name + (e.isDirectory() ? '/' : ''))
        .join('\n') || '(empty)';
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  }
  if (name === 'read_file') {
    const rel = safeRelPath(args.path);
    if (rel === null) return 'ERROR: path not allowed';
    const stagedFile = staged.files.find((f) => f.path === rel);
    let text;
    if (stagedFile) {
      text = stagedFile.content;
    } else {
      try { text = fs.readFileSync(path.join(workspacePath, rel), 'utf8'); }
      catch (error) { return `ERROR: ${error.message}`; }
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const slice = text.slice(offset, offset + 6000);
    staged.readPaths.add(rel);
    return text.length > offset + 6000
      ? `${slice}\n...[truncated, file is ${text.length} chars — call read_file with offset=${offset + 6000} for the rest]`
      : slice;
  }
  if (name === 'write_file') {
    const rel = safeRelPath(args.path);
    if (rel === null) return 'ERROR: path not allowed';
    if (typeof args.content !== 'string' || !args.content.trim()) return 'ERROR: content is required';
    const target = path.join(workspacePath, rel);
    // Guard against the model replacing a real file with a fragment
    try {
      const oldSize = fs.statSync(target).size;
      if (oldSize > 400 && args.content.length < oldSize * 0.3) {
        return `REJECTED: ${rel} is ${oldSize} bytes but your content is only ${args.content.length} chars. write_file requires the COMPLETE updated file — read_file it first, then resubmit the whole file with your change merged in.`;
      }
      if (!staged.readPaths.has(rel)) {
        return `REJECTED: ${rel} already exists — read_file it before writing so your version preserves existing code.`;
      }
    } catch {}
    const index = staged.files.findIndex((f) => f.path === rel);
    const entry = { path: rel, content: args.content };
    if (index >= 0) staged.files[index] = entry; else staged.files.push(entry);
    return `STAGED ${rel} (${args.content.length} chars). It will be applied to the workspace after human review.`;
  }
  return `ERROR: unknown tool ${name}`;
}

function persistStagedRun(staged) {
  const dir = path.join(stagingRoot, staged.id);
  for (const f of staged.files) {
    const target = path.join(dir, 'files', f.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({ id: staged.id, createdAt: new Date().toISOString(), prompt: staged.prompt, files: staged.files.map((f) => ({ path: f.path, chars: f.content.length })) }, null, 2)
  );
}

async function applyStagedRun(req, res) {
  try {
    const { id } = await readJsonBody(req);
    if (!/^stage-[\w-]+$/.test(id || '')) {
      sendJson(res, 400, { error: 'Valid stage id is required.' });
      return;
    }
    const dir = path.join(stagingRoot, id);
    const manifestFile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) {
      sendJson(res, 404, { error: 'Staged run not found.' });
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.appliedAt) {
      sendJson(res, 409, { error: `Already applied at ${manifest.appliedAt}.` });
      return;
    }
    const backupDir = path.join(backupRoot, id);
    const applied = [];
    for (const f of manifest.files) {
      const rel = safeRelPath(f.path);
      if (!rel) continue;
      const src = path.join(dir, 'files', rel);
      if (!fs.existsSync(src)) continue;
      const dest = path.join(workspacePath, rel);
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, rel);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dest, bak);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      applied.push(rel);
    }
    manifest.appliedAt = new Date().toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    sendJson(res, 200, { ok: true, applied, backupDir });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

async function handleBuildOrchestration(res, controller, prompt, histMsgs, ctxBlock, attachBlock = '') {
  const recentHist = histMsgs.slice(-6);

  // Step 1: Plan (GPT-4o) — grounded in the real workspace tree + attached files
  sseWrite(res, '\n**[PLANNING — GPT-4o]**\n\n');
  const planMessages = [
    { role: 'system', content: `You are a senior software architect. Produce a tight, numbered implementation plan for the executor agent. Specify exact files to modify or create, key functions/APIs involved, and the technical approach. Only reference files that exist in the workspace tree below (or clearly mark new files as NEW). Be concise — no code, no filler.\n\nWORKSPACE FILE TREE:\n${workspaceTree()}${attachBlock}${ctxBlock}` },
    ...recentHist,
    { role: 'user', content: `Create an implementation plan for:\n\n${prompt}` }
  ];
  let planText = '';
  try {
    const up = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${openAiApiKey}` },
      body: JSON.stringify({ model: 'gpt-4o', messages: planMessages, stream: true, temperature: 0.3, max_tokens: 700 })
    });
    if (up.ok) planText = await streamUpstream(up, (d) => sseWrite(res, d));
    else sseWrite(res, `[Planning failed: ${up.status}]\n`);
  } catch (err) {
    if (err.name === 'AbortError') { res.write('data: [DONE]\n\n'); res.end(); return; }
    sseWrite(res, `[Planning error: ${err.message}]\n`);
  }

  if (!planText || controller.signal.aborted) { res.write('data: [DONE]\n\n'); res.end(); return; }

  // Step 2: Execute (Qwen local, tool-calling agent loop; changes are staged, never written directly)
  sseWrite(res, '\n\n---\n**[EXECUTING — QWEN LOCAL + TOOLS]**\n\n');
  const staged = { id: `stage-${Date.now()}`, prompt, files: [], readPaths: new Set() };
  const execMessages = [
    { role: 'system', content: `You are a coding agent working inside an existing workspace. You have tools: list_dir, read_file, write_file, run_command.\nRules:\n- ALWAYS read_file before modifying an existing file; write_file content must be the COMPLETE updated file.\n- Make the minimal change that satisfies the plan. Do not refactor unrelated code.\n- Use run_command for syntax checks, tests, builds, and git inspection. Commands see the real workspace, not your staged changes.\n- When the plan is implemented, stop calling tools and reply with a short summary of what you changed (no code).${attachBlock}` },
    { role: 'user', content: `Task: ${prompt}\n\nPlan from architect:\n${planText.slice(0, 3000)}\n\nImplement this now using your tools.` }
  ];
  let execSummary = '';
  for (let turn = 0; turn < 12 && !controller.signal.aborted; turn++) {
    let payload;
    try {
      const r = await fetch(new URL('/v1/chat/completions', llamaServerUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: localModel, messages: execMessages, tools: EXEC_TOOLS, tool_choice: 'auto', stream: false, temperature: 0.2, max_tokens: 1600 })
      });
      payload = await r.json();
      if (!r.ok) throw new Error(payload?.error?.message || `status ${r.status}`);
    } catch (err) {
      if (err.name === 'AbortError') { res.write('data: [DONE]\n\n'); res.end(); return; }
      sseWrite(res, `\n[Execution error: ${err.message}]\n`);
      break;
    }
    const msg = payload.choices?.[0]?.message || {};
    if (Array.isArray(msg.tool_calls) && msg.tool_calls.length) {
      execMessages.push({ role: 'assistant', content: msg.content || '', tool_calls: msg.tool_calls });
      for (const call of msg.tool_calls) {
        let args = {};
        try { args = JSON.parse(call.function?.arguments || '{}'); } catch {}
        const result = await runExecTool(call.function?.name, args, staged);
        const failed = result.startsWith('ERROR') || result.startsWith('REJECTED');
        sseWrite(res, `→ ${call.function?.name}(${args.path || args.command || ''}) ${failed ? '✗' : '✓'}\n`);
        execMessages.push({ role: 'tool', tool_call_id: call.id, content: String(result) });
      }
      continue;
    }
    execSummary = msg.content || '';
    break;
  }
  if (execSummary) sseWrite(res, `\n${execSummary}\n`);

  if (controller.signal.aborted) { res.write('data: [DONE]\n\n'); res.end(); return; }
  if (!staged.files.length) {
    sseWrite(res, '\n[No file changes were staged — nothing to QC or apply.]\n');
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }
  persistStagedRun(staged);

  // Step 3: QC (NVIDIA NIM) — reviews the actual staged files, hard 60s budget
  if (nimApiKey) {
    sseWrite(res, `\n\n---\n**[QC — NIM ${nimModel}]**\n\n`);
    try {
      let budget = 9000;
      const fileBlocks = staged.files.map((f) => {
        const part = f.content.slice(0, Math.max(0, budget));
        budget -= part.length;
        return `### ${f.path}\n${part}`;
      }).join('\n\n');
      const qcUp = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(60_000)]),
        headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${nimApiKey}` },
        body: JSON.stringify({
          model: nimModel,
          messages: [
            { role: 'system', content: 'You are a senior code reviewer. Review the staged file changes for bugs, regressions, and missing pieces relative to the plan. Be concise — 3-5 bullet points max. End with verdict: SHIP or HOLD.' },
            { role: 'user', content: `Task: ${prompt}\n\nPlan:\n${planText.slice(0, 2000)}\n\nStaged files:\n${fileBlocks}\n\nQC review:` }
          ],
          stream: true, temperature: 0.2, max_tokens: 500
        })
      });
      if (qcUp.ok) await streamUpstream(qcUp, (d) => sseWrite(res, d));
      else sseWrite(res, `[QC failed: ${qcUp.status}]\n`);
    } catch (err) {
      if (err.name === 'TimeoutError') sseWrite(res, '[QC timed out after 60s — review staged files manually.]\n');
      else if (err.name !== 'AbortError') sseWrite(res, `[QC error: ${err.message}]\n`);
    }
  }

  sseWrite(res, `\n\n[STAGED:${staged.id}] ${staged.files.length} file(s) staged: ${staged.files.map((f) => f.path).join(', ')}. Review above, then APPLY to write to the workspace.\n`);
  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleChat(req, res) {
  try {
    const { prompt, mode = 'ask', history = [], attachments = [] } = await readJsonBody(req);
    if (!prompt?.trim()) {
      sendJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    let attachBlock = '';
    const attachList = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a?.name && typeof a.content === 'string')
      .slice(0, 60);
    if (attachList.length) {
      let budget = 24_000;
      const parts = [];
      for (const a of attachList) {
        if (budget <= 0) break;
        const chunk = a.content.slice(0, Math.min(8000, budget));
        budget -= chunk.length;
        parts.push(`--- FILE: ${String(a.name).slice(0, 200)} ---\n${chunk}`);
      }
      attachBlock = `\n\n--- USER-ATTACHED FILES ---\n${parts.join('\n\n')}\n--- END ATTACHED FILES ---`;
    }

    const dashCtx = await buildDashboardContext();
    const ctxBlock = `\n\n--- LIVE DASHBOARD CONTEXT ---\n${dashCtx}\n--- END CONTEXT ---`;

    const systemPrompts = {
      ask: `You are Maverick, the AI operations assistant for Maverick Integrations. You are friendly, direct, and concise. You have access to live data from the MCC dashboard — use it to answer questions about system status, active work, and operations. When the user asks about their environment, customers, or work in progress, reference the context below.${ctxBlock}`,
      build: `You are Maverick in BUILD mode. Focus on code, implementation, and technical execution. Be precise and provide working code. Avoid explanations unless asked.${ctxBlock}`,
      review: `You are Maverick in REVIEW mode. Analyze carefully, reason through edge cases, and provide thorough structured explanations. Reference the dashboard context when relevant.${ctxBlock}`,
      ops: `You are Maverick in OPS mode. You are a systems expert focused on operations, debugging, infrastructure, and system health. Use the live dashboard context to diagnose issues and recommend actions.${ctxBlock}`,
    };
    const system = systemPrompts[mode] || systemPrompts.ask;

    // Sanitize history — only valid user/assistant turns with content
    const histMsgs = (Array.isArray(history) ? history : [])
      .slice(-20)
      .filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
      .map(m => ({ role: m.role, content: String(m.content) }));

    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache',
      'connection': 'keep-alive',
      'x-accel-buffering': 'no'
    });

    const controller = new AbortController();
    req.on('close', () => controller.abort());

    // BUILD + OPS → GPT-4o plan → Qwen execute (tool calls, staged) → NIM QC
    if (mode === 'build' || mode === 'ops') {
      await handleBuildOrchestration(res, controller, prompt.trim(), histMsgs, ctxBlock, attachBlock);
      return;
    }

    // ASK + REVIEW → Gemini Flash (if key set), OPS → local Qwen
    const useGemini = GEMINI_MODES.has(mode) && geminiApiKey;
    const messages = [
      { role: 'system', content: system + attachBlock },
      ...histMsgs,
      { role: 'user', content: prompt.trim() }
    ];

    let upstream;
    try {
      if (useGemini) {
        upstream = await fetch(
          'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
          {
            method: 'POST',
            signal: controller.signal,
            headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${geminiApiKey}` },
            body: JSON.stringify({ model: geminiModel, messages, stream: true, temperature: 0.7, max_tokens: 1400 })
          }
        );
      } else {
        upstream = await fetch(new URL('/v1/chat/completions', llamaServerUrl), {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
          body: JSON.stringify({ model: localModel, messages, stream: true, temperature: 0.7, max_tokens: 1400 })
        });
      }
    } catch (fetchErr) {
      res.write(`data: ${JSON.stringify({ error: fetchErr.message })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    if (!upstream.ok) {
      const errText = await upstream.text().catch(() => `status ${upstream.status}`);
      res.write(`data: ${JSON.stringify({ error: errText })}\n\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!res.writable) break;
        res.write(decoder.decode(value, { stream: true }));
      }
    } finally {
      reader.releaseLock();
      if (res.writable) res.end();
    }
  } catch (error) {
    if (error.name !== 'AbortError') {
      try {
        res.write(`data: ${JSON.stringify({ error: error.message })}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
      } catch {}
    }
  }
}

const ALLOWED_ORIGINS = [
  'https://homelab-noc-dashboard.vercel.app',
  'http://localhost:5173',
  'http://localhost:3011',
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS — allow Vercel frontend and local dev
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app')) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }
  if (url.pathname === '/api/chat' && req.method === 'POST') {
    await handleChat(req, res);
    return;
  }
  if (url.pathname === '/api/deploy/status') {
    sendJson(res, 200, { state: 'ok', deployedAt: deployStartedAt });
    return;
  }
  if (url.pathname === '/api/query') {
    await proxyPrometheus(req, res, url);
    return;
  }
  if (url.pathname === '/api/llm/status') {
    await getLlamaStatus(res);
    return;
  }
  if (url.pathname === '/api/orchestrator/status') {
    await getOrchestratorStatus(res);
    return;
  }
  if (url.pathname === '/api/memory') {
    const query = url.searchParams.get('query');
    sendJson(res, 200, await getMemoryIndex(query || ''));
    return;
  }
  if (url.pathname === '/api/workflows/seo') {
    sendJson(res, 200, await getSeoWorkflowStatus());
    return;
  }
  if (url.pathname === '/api/workflows/seo/actions') {
    await proxySeoActions(req, res, 'list');
    return;
  }
  if (url.pathname === '/api/workflows/seo/actions/approve' && req.method === 'POST') {
    await proxySeoActions(req, res, 'approve');
    return;
  }
  if (url.pathname === '/api/workflows/seo/actions/run' && req.method === 'POST') {
    await proxySeoActions(req, res, 'run');
    return;
  }
  if (url.pathname === '/api/orchestrator/plan' && req.method === 'POST') {
    await createOrchestratorPlan(req, res);
    return;
  }
  if (url.pathname === '/api/orchestrator/local-brief' && req.method === 'POST') {
    await createLocalWorkerBrief(req, res);
    return;
  }
  if (url.pathname === '/api/orchestrator/task-run' && req.method === 'POST') {
    await createTaskRun(req, res);
    return;
  }
  if (url.pathname === '/api/orchestrator/task-run' && req.method === 'PATCH') {
    await updateTaskRun(req, res);
    return;
  }
  if (url.pathname === '/api/build/apply' && req.method === 'POST') {
    await applyStagedRun(req, res);
    return;
  }
  if (url.pathname === '/health') {
    send(res, 200, 'ok\n');
    return;
  }

  const requestedPath = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.normalize(path.join(distDir, requestedPath));
  if (!filePath.startsWith(distDir)) {
    send(res, 403, 'forbidden\n');
    return;
  }
  const finalPath = fs.existsSync(filePath) ? filePath : path.join(distDir, 'index.html');
  fs.readFile(finalPath, (error, data) => {
    if (error) {
      send(res, 404, 'not found\n');
      return;
    }
    send(res, 200, data, types[path.extname(finalPath).toLowerCase()] || 'application/octet-stream');
  });
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mav-console dashboard listening on http://0.0.0.0:${port}`);
  console.log(`Prometheus: ${prometheusUrl}`);
  console.log(`llama.cpp: ${llamaServerUrl}`);
});
