import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 3011);
const deployStartedAt = new Date().toISOString();
const prometheusUrl = process.env.PROMETHEUS_URL || 'http://192.168.1.12:9090';
const ragUrl = process.env.MAV_RAG_URL || 'http://192.168.1.12:8181';
const llamaServerUrl = process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080';
const localModel = process.env.LOCAL_MODEL || 'qwen3-14b';
const piExecutable = process.env.PI_EXECUTABLE || 'pi';
const piModel = process.env.PI_MODEL || 'qwen3-14b';
const repoBridgeUrl = process.env.MAV_REPO_BRIDGE_URL || '';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_MODES = new Set(['review']); // Gemini = everyday chat only (REVIEW mode)
const openAiApiKey = process.env.OPENAI_API_KEY || '';
const nimApiKey = process.env.NVIDIA_NIM_API_KEY || '';
// qwen2.5-coder-32b retired (410), qwen3.5-122b-a10b too slow (60s timeout) — llama-3.3-70b for main tasks
const nimModel = process.env.NIM_MODEL || 'meta/llama-3.3-70b-instruct';
// QC uses a fast 8B model — "SHIP or HOLD" doesn't need a 70B model
const nimQcModel = process.env.NIM_QC_MODEL || 'meta/llama-3.1-8b-instruct';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
// Brave Search — free tier 2k queries/month: brave.com/search/api/
// TODO: Add BRAVE_SEARCH_API_KEY to .env once you get the key
const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || '';
const dataDir = process.env.MAV_CONSOLE_DATA_DIR || path.join(__dirname, '.mav-console');
const ledgerFile = path.join(dataDir, 'task-runs.json');
const workspacePath = process.env.MAV_CONSOLE_WORKSPACE || __dirname;
const memoryPath = process.env.MAV_MEMORY_PATH || 'C:\\Users\\carte\\.claude\\projects\\memory';
const skillsPath = process.env.MAV_SKILLS_PATH || path.join(__dirname, 'skills');

// Blocked system and sensitive paths — everything else is accessible.
// MAV_EXTRA_ROOTS is kept for backward compat but no longer needed for access control.
const BLOCKED_ABS_RE = /[/\\](\.env$|\.git[/\\]|Windows[/\\]|Program Files[/\\]?|AppData[/\\]Local[/\\]Temp|System32[/\\]|SysWOW64[/\\]|WindowsApps[/\\])/i;

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

function triggerSelfImprove() {
  const scriptPath = path.join(__dirname, 'scripts', 'qwen-self-improve.mjs');
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MAV_MEMORY_PATH: memoryPath }
  });
  child.unref();
  console.log('[self-improve] triggered in background');
}

function recordChatFailure(mode, prompt, error) {
  try {
    const workerMap = { build: 'claude-qwen-build', ops: 'claude-qwen-ops', ask: 'ask-maverick' };
    const run = {
      id: `chat-${Date.now()}`,
      taskTitle: `${mode.toUpperCase()}: ${String(prompt).slice(0, 80)}`,
      worker: workerMap[mode] || mode,
      status: 'failed',
      error: String(error),
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    addLedgerRun(run);
    triggerSelfImprove();
  } catch {}
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
    .filter((file) => file.toLowerCase().endsWith('.md') && file.toLowerCase() !== 'memory.md')
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
      triggerSelfImprove();
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
    if (patch.status === 'failed') triggerSelfImprove();
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
const BLOCKED_REL = /^(\.env$|\.git(\/|$)|node_modules(\/|$)|package-lock\.json$|tmp(\/|$)|\.mav-console(\/|$))/i;

// Resolve a path that may be absolute or relative.
// Returns the normalized absolute path if allowed, or null if blocked.
function resolveSafePath(p) {
  if (!p || typeof p !== 'string') return null;
  const trimmed = p.trim();
  let abs;
  if (path.isAbsolute(trimmed)) {
    abs = path.normalize(trimmed);
  } else {
    // Strip leading slashes/dots for relative paths
    const rel = path.normalize(trimmed.replace(/^[/\\]+/, ''));
    if (rel.split(/[/\\]/).includes('..')) return null;
    if (BLOCKED_REL.test(rel.replace(/\\/g, '/'))) return null;
    abs = path.join(workspacePath, rel);
  }
  // Block Windows system and sensitive directories only
  if (BLOCKED_ABS_RE.test(abs)) return null;
  return abs;
}

function loadSkills() {
  try {
    if (!fs.existsSync(skillsPath)) return '';
    const files = fs.readdirSync(skillsPath).filter(f => f.endsWith('.md')).sort();
    if (!files.length) return '';
    const parts = files.map(f => {
      try { return fs.readFileSync(path.join(skillsPath, f), 'utf8').slice(0, 2500); } catch { return ''; }
    }).filter(Boolean);
    return parts.length ? parts.join('\n\n---\n\n') : '';
  } catch { return ''; }
}

function workspaceTree() {
  const lines = [];
  const skip = new Set(['node_modules', '.git', 'dist', 'tmp', '.mav-console', '.venv', '__pycache__', '$Recycle.Bin', 'System Volume Information']);
  const walk = (dir, prefix, depth, maxDepth) => {
    if (depth > maxDepth || lines.length >= 200) return;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (skip.has(e.name) || e.name.startsWith('.') || lines.length >= 200) continue;
      lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
      if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/', depth + 1, maxDepth);
    }
  };

  // MCC project — deep
  lines.push(`[MCC] ${workspacePath}`);
  walk(workspacePath, '  ', 0, 3);

  // Skills dir — shallow
  if (skillsPath !== workspacePath && fs.existsSync(skillsPath)) {
    lines.push(`\n[SKILLS] ${skillsPath}`);
    walk(skillsPath, '  ', 0, 1);
  }

  // Parent dir — show sibling projects so Claude can navigate beyond MCC
  const parentDir = path.dirname(workspacePath);
  if (parentDir !== workspacePath && fs.existsSync(parentDir)) {
    lines.push(`\n[WORKSPACE ROOT] ${parentDir}`);
    walk(parentDir, '  ', 0, 1);
  }

  // Other drive roots on Windows — list top-level dirs so Claude knows what drives exist
  if (process.platform === 'win32') {
    const workspaceDriveRoot = path.parse(workspacePath).root;
    for (const drive of ['C:\\', 'D:\\', 'E:\\', 'F:\\']) {
      if (drive.toLowerCase() === workspaceDriveRoot.toLowerCase()) continue;
      if (fs.existsSync(drive)) {
        lines.push(`\n[DRIVE] ${drive}`);
        walk(drive, '  ', 0, 1);
      }
    }
  }

  return lines.join('\n');
}

const EXEC_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'List files in a directory. Accepts absolute paths (e.g. C:\\Workspace\\MyProject) or relative paths from the MCC root. Directories end with /.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or relative directory path.' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file. Accepts absolute or relative paths. Returns up to 6000 characters; use offset to page through large files.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Delegate a file write to Pi (local coding agent). Pi reads the file, applies the instruction, and writes to disk immediately — no staging. Provide an exact instruction describing what to change.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a short-lived command in the MCC workspace. No shell operators (| ; && > etc). NEVER use for long-running servers: npm run dev, npm start, next dev, vite, nodemon are all blocked. Useful for: npm install, npx, node --check, git, pm2 list/logs/status, python, dir.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch the content of any public URL and return it as plain text. Strips HTML tags. Good for reading documentation, API responses, JSON feeds, or checking if a URL is reachable. Returns up to 4000 characters.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL including https://' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web using Brave Search API. Returns top 5 results with titles, URLs, and descriptions. Use when you need current information, package docs, error solutions, or anything you cannot find in local files.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } },
  { type: 'function', function: { name: 'delete_file', description: 'Delegate a file deletion to Pi (local coding agent). Pi deletes the file immediately from disk — no staging. Files only, not directories.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or relative path to the file to delete.' } }, required: ['path'] } } }
];

const BLOCKED_COMMANDS = /(\brmdir\b|\bdel\b|\brd\b|\brm\b|\bformat\b|\bregdel\b|\bpowershell.*-enc\b|\bcurl.*\|\s*bash\b|npm\s+run\s+dev\b|npm\s+run\s+start\b|npm\s+start\b|next\s+dev\b|next\s+start\b|vite\b|nodemon\b)/i;
const SAFE_COMMAND = /^(node|npm|npx|git|pm2|python|python3|dir|type|where|echo|ping|tracert|nslookup|ipconfig|mkdir|md|move|copy|ren|rename)\b/i;

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
    if (BLOCKED_COMMANDS.test(cmd)) return 'ERROR: command is blocked for safety.';
    if (!SAFE_COMMAND.test(cmd)) return 'ERROR: command not recognised. Allowed prefixes: node, npm, npx, git, pm2, python, python3, dir, type, where, echo, ping, tracert, nslookup, ipconfig.';
    return runShellCommand(cmd);
  }
  if (name === 'list_dir') {
    const abs = resolveSafePath(args.path || '.');
    if (abs === null) return 'ERROR: path not allowed';
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
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
    const abs = resolveSafePath(args.path);
    if (abs === null) return 'ERROR: path not allowed';
    const stagedFile = staged.files.find((f) => f.path === abs);
    let text;
    if (stagedFile) {
      text = stagedFile.content;
    } else {
      try { text = fs.readFileSync(abs, 'utf8'); }
      catch (error) { return `ERROR: ${error.message}`; }
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const slice = text.slice(offset, offset + 6000);
    staged.readPaths.add(abs);
    return text.length > offset + 6000
      ? `${slice}\n...[truncated, file is ${text.length} chars — call read_file with offset=${offset + 6000} for the rest]`
      : slice;
  }
  if (name === 'write_file') {
    const abs = resolveSafePath(args.path);
    if (abs === null) return 'ERROR: path not allowed';
    if (typeof args.content !== 'string' || !args.content.trim()) return 'ERROR: content is required';
    // Guard against the model replacing a real file with a fragment
    try {
      const oldSize = fs.statSync(abs).size;
      if (oldSize > 400 && args.content.length < oldSize * 0.3) {
        return `REJECTED: ${abs} is ${oldSize} bytes but your content is only ${args.content.length} chars. write_file requires the COMPLETE updated file — read_file it first, then resubmit the whole file with your change merged in.`;
      }
      if (!staged.readPaths.has(abs)) {
        return `REJECTED: ${abs} already exists — read_file it before writing so your version preserves existing code.`;
      }
    } catch {}
    const index = staged.files.findIndex((f) => f.path === abs);
    const entry = { path: abs, content: args.content };
    if (index >= 0) staged.files[index] = entry; else staged.files.push(entry);
    return `STAGED ${abs} (${args.content.length} chars). It will be applied to the workspace after human review.`;
  }
  if (name === 'delete_file') {
    const abs = resolveSafePath(args.path);
    if (abs === null) return 'ERROR: path not allowed';
    if (abs.startsWith(stagingRoot) || abs.startsWith(backupRoot)) return 'ERROR: cannot delete build staging or backup infrastructure';
    try {
      const stat = fs.statSync(abs);
      if (stat.isDirectory()) return 'ERROR: delete_file only removes files. Use run_command to handle directories.';
    } catch { return `ERROR: file not found — ${abs}`; }
    const index = staged.files.findIndex((f) => f.path === abs);
    const entry = { path: abs, content: '__DELETE__' };
    if (index >= 0) staged.files[index] = entry; else staged.files.push(entry);
    return `STAGED deletion of ${abs}. File will be backed up and removed after human review.`;
  }
  if (name === 'fetch_url') {
    const url = String(args.url || '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) return 'ERROR: URL must start with http:// or https://';
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickMCC/1.0)' },
        signal: AbortSignal.timeout(15_000)
      });
      if (!r.ok) return `ERROR: HTTP ${r.status} from ${url}`;
      const ct = r.headers.get('content-type') || '';
      const raw = await r.text();
      if (ct.includes('json') || url.endsWith('.json')) return raw.slice(0, 4000);
      const stripped = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return stripped.length > 4000 ? stripped.slice(0, 4000) + '\n...[truncated]' : stripped;
    } catch (err) { return `ERROR: ${err.message}`; }
  }
  if (name === 'web_search') {
    if (!braveApiKey) return 'ERROR: Web search not configured. Add BRAVE_SEARCH_API_KEY to .env — free key at brave.com/search/api/';
    const query = String(args.query || '').trim();
    if (!query) return 'ERROR: query is required';
    try {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveApiKey },
        signal: AbortSignal.timeout(10_000)
      });
      if (!r.ok) return `ERROR: Brave API ${r.status} — ${await r.text().catch(() => '')}`;
      const data = await r.json();
      const results = (data.web?.results || []).slice(0, 5)
        .map((res, i) => `${i + 1}. ${res.title}\n   ${res.url}\n   ${res.description || ''}`)
        .join('\n\n');
      return results || 'No results found';
    } catch (err) { return `ERROR: ${err.message}`; }
  }
  return `ERROR: unknown tool ${name}`;
}

// Convert an absolute path to a safe relative path for staging storage
function stagingSlug(p) {
  return p.replace(/^[A-Za-z]:/, '').replace(/\\/g, '/').replace(/^\/+/, '');
}

// OPS-mode executor — handles personal assistant tools not in runExecTool
async function runOpsExecTool(name, args, staged) {
  // Document: read Word
  if (name === 'read_docx') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const { default: mammoth } = await import('mammoth');
      const result = await mammoth.extractRawText({ path: abs });
      const text = result.value || '';
      return text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text || '(empty document)';
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Document: read PDF
  if (name === 'read_pdf') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const { createRequire } = await import('module');
      const req = createRequire(import.meta.url);
      const pdfParse = req('pdf-parse');
      const buf = fs.readFileSync(abs);
      const data = await pdfParse(buf);
      const text = data.text || '';
      return text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text || '(empty PDF)';
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Document: read Excel
  if (name === 'read_xlsx') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const { default: XLSX } = await import('xlsx');
      const wb = XLSX.readFile(abs);
      const sheetName = args.sheet || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      if (!ws) return `ERROR: Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(', ')}`;
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const preview = JSON.stringify(rows.slice(0, 50), null, 2);
      return `Sheet: ${sheetName} (${rows.length} rows)\n${preview}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Document: write Excel
  if (name === 'write_xlsx') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    const sheets = Array.isArray(args.sheets) ? args.sheets : [];
    if (!sheets.length) return 'ERROR: sheets array required';
    try {
      const { default: XLSX } = await import('xlsx');
      const wb = XLSX.utils.book_new();
      for (const s of sheets) {
        const headers = Array.isArray(s.headers) ? s.headers : [];
        const rows = Array.isArray(s.rows) ? s.rows : [];
        const wsData = headers.length ? [headers, ...rows] : rows;
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, String(s.name || 'Sheet1').slice(0, 31));
      }
      XLSX.writeFile(wb, abs);
      staged.files.push({ path: abs, content: `[binary xlsx: ${sheets.length} sheet(s)]` });
      return `CREATED ${abs} with ${sheets.length} sheet(s): ${sheets.map(s => s.name).join(', ')}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Document: write CSV
  if (name === 'write_csv') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    const headers = Array.isArray(args.headers) ? args.headers : [];
    const rows = Array.isArray(args.rows) ? args.rows : [];
    try {
      const escape = (v) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [];
      if (headers.length) lines.push(headers.map(escape).join(','));
      for (const row of rows) lines.push((Array.isArray(row) ? row : Object.values(row)).map(escape).join(','));
      const csv = lines.join('\n');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, csv, 'utf8');
      staged.files.push({ path: abs, content: csv });
      return `CREATED ${abs} (${lines.length} rows, ${csv.length} chars). Staged for APPLY.`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Document: read CSV
  if (name === 'read_csv') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const preview = lines.slice(0, 50).join('\n');
      return `${lines.length} rows\n${preview}${lines.length > 50 ? '\n...[truncated]' : ''}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Email helpers
  function getEmailConfig() {
    const imapHost = process.env.EMAIL_IMAP_HOST;
    const imapPort = Number(process.env.EMAIL_IMAP_PORT || 993);
    const imapUser = process.env.EMAIL_IMAP_USER;
    const imapPass = process.env.EMAIL_IMAP_PASS;
    const smtpHost = process.env.EMAIL_SMTP_HOST || imapHost?.replace('imap.', 'smtp.');
    const smtpPort = Number(process.env.EMAIL_SMTP_PORT || 587);
    const smtpUser = process.env.EMAIL_SMTP_USER || imapUser;
    const smtpPass = process.env.EMAIL_SMTP_PASS || imapPass;
    return { imapHost, imapPort, imapUser, imapPass, smtpHost, smtpPort, smtpUser, smtpPass };
  }

  // Email: list
  if (name === 'list_emails') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured. Add EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS to .env';
    const mailbox = String(args.mailbox || 'INBOX');
    const limit = Math.min(Number(args.limit || 20), 50);
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msgs = [];
        for await (const msg of client.fetch({ seq: `${Math.max(1, client.mailbox.exists - limit + 1)}:*` }, { envelope: true, uid: true })) {
          msgs.push({ uid: msg.uid, seq: msg.seq, subject: msg.envelope.subject || '(no subject)', from: msg.envelope.from?.[0]?.address || '', date: msg.envelope.date?.toISOString() || '' });
        }
        return JSON.stringify(msgs.reverse(), null, 2);
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Email: read
  if (name === 'read_email') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const uid = String(args.uid || '');
    if (!uid) return 'ERROR: uid required';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true, source: true }, { uid: true });
        if (!msg) return `ERROR: Message UID ${uid} not found`;
        const src = msg.source?.toString('utf8') || '';
        // Strip base64 attachments, keep headers + text parts
        const stripped = src.replace(/Content-Transfer-Encoding: base64[\s\S]*?(?=--|\z)/gi, '[attachment]\n').slice(0, 6000);
        return `From: ${msg.envelope.from?.[0]?.address}\nSubject: ${msg.envelope.subject}\nDate: ${msg.envelope.date}\n\n${stripped}`;
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Email: search
  if (name === 'search_emails') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const query = String(args.query || '').trim();
    if (!query) return 'ERROR: query required';
    const limit = Math.min(Number(args.limit || 10), 30);
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
        const slice = uids.slice(-limit);
        const msgs = [];
        for await (const msg of client.fetch(slice.join(','), { envelope: true, uid: true }, { uid: true })) {
          msgs.push({ uid: msg.uid, subject: msg.envelope.subject || '(no subject)', from: msg.envelope.from?.[0]?.address || '', date: msg.envelope.date?.toISOString() || '' });
        }
        return `Found ${uids.length} messages (showing ${msgs.length}):\n${JSON.stringify(msgs.reverse(), null, 2)}`;
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Email: send
  if (name === 'send_email') {
    const cfg = getEmailConfig();
    if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) return 'ERROR: Email not configured. Add EMAIL_SMTP_HOST, EMAIL_SMTP_USER, EMAIL_SMTP_PASS to .env';
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '').trim();
    if (!to || !subject || !body) return 'ERROR: to, subject, and body are required';
    try {
      const { default: nodemailer } = await import('nodemailer');
      const transporter = nodemailer.createTransport({ host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpPort === 465, auth: { user: cfg.smtpUser, pass: cfg.smtpPass } });
      const info = await transporter.sendMail({ from: cfg.smtpUser, to, cc: args.cc || undefined, subject, text: body });
      return `Email sent. Message ID: ${info.messageId}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Email: create draft
  if (name === 'create_draft') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '').trim();
    if (!to || !subject) return 'ERROR: to and subject are required';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const raw = `From: ${cfg.imapUser}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}`;
      await client.append('Drafts', Buffer.from(raw), ['\\Draft']);
      await client.logout();
      return `Draft saved to Drafts folder: "${subject}" → ${to}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Email: label/move
  if (name === 'label_email') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const uid = String(args.uid || '');
    const label = String(args.label || '').trim();
    if (!uid || !label) return 'ERROR: uid and label required';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.messageMove(uid, label, { uid: true });
        return `Moved message UID ${uid} to ${label}`;
      } catch {
        await client.messageFlagsAdd(uid, [`\\${label}`], { uid: true });
        return `Applied label "${label}" to message UID ${uid}`;
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // File: move
  if (name === 'move_file') {
    const src = resolveSafePath(args.from);
    const dest = resolveSafePath(args.to);
    if (!src) return 'ERROR: source path not allowed';
    if (!dest) return 'ERROR: destination path not allowed';
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(src, dest); return `Moved ${src} → ${dest}`; }
    catch (err) { return `ERROR: ${err.message}`; }
  }

  // File: copy
  if (name === 'copy_file') {
    const src = resolveSafePath(args.from);
    const dest = resolveSafePath(args.to);
    if (!src) return 'ERROR: source path not allowed';
    if (!dest) return 'ERROR: destination path not allowed';
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return `Copied ${src} → ${dest}`; }
    catch (err) { return `ERROR: ${err.message}`; }
  }

  // File: delete (staged only — never immediate)
  if (name === 'delete_file') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    staged.files.push({ path: abs, content: '__DELETE__' });
    return `DELETE staged for ${abs}. This will be executed when user clicks APPLY.`;
  }

  // Analysis: image via Anthropic Vision
  if (name === 'analyze_image') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    if (!anthropicApiKey) return 'ERROR: ANTHROPIC_API_KEY not configured';
    try {
      const imgBuf = fs.readFileSync(abs);
      const base64 = imgBuf.toString('base64');
      const ext = path.extname(abs).toLowerCase().replace('.', '');
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mediaType = mimeMap[ext] || 'image/jpeg';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }, { type: 'text', text: 'Describe this image in detail.' }] }]
        })
      });
      if (!r.ok) return `ERROR: Vision API ${r.status}`;
      const payload = await r.json();
      return payload.content?.[0]?.text || '(no description)';
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  // Agent: create agent .md definition (staged for review)
  if (name === 'create_agent') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    const content = String(args.content || '').trim();
    if (!content) return 'ERROR: content required';
    staged.files.push({ path: abs, content });
    return `STAGED agent definition at ${abs}. Click APPLY to write it to disk.`;
  }

  // Skill: create skill .md (staged for review)
  if (name === 'create_skill') {
    const abs = resolveSafePath(args.path || path.join(skillsPath, 'new-skill.md'));
    if (!abs) return 'ERROR: path not allowed';
    const content = String(args.content || '').trim();
    if (!content) return 'ERROR: content required';
    staged.files.push({ path: abs, content });
    return `STAGED skill at ${abs}. Click APPLY to install it into the skills library.`;
  }

  // PM2: deploy service
  if (name === 'deploy_pm2') {
    const script = String(args.script || '').trim();
    const svcName = String(args.name || '').trim();
    const cwd = String(args.cwd || path.dirname(script)).trim();
    if (!script || !svcName) return 'ERROR: script and name required';
    const ecosystemPath = path.join(cwd, 'ecosystem.config.cjs');
    let ecosystem = { apps: [] };
    try {
      const raw = fs.readFileSync(ecosystemPath, 'utf8');
      // ecosystem files export a module — parse the JSON object literal inside
      const m = raw.match(/module\.exports\s*=\s*(\{[\s\S]*\});?\s*$/);
      if (m) ecosystem = JSON.parse(m[1]);
    } catch {}
    ecosystem.apps = (ecosystem.apps || []).filter(a => a.name !== svcName);
    ecosystem.apps.push({ name: svcName, script, cwd, autorestart: true, max_restarts: 5, env: { NODE_ENV: 'production' } });
    const content = `module.exports = ${JSON.stringify(ecosystem, null, 2)};\n`;
    staged.files.push({ path: ecosystemPath, content });
    if (!staged.pm2Commands) staged.pm2Commands = [];
    staged.pm2Commands.push({ ecosystemPath, name: svcName });
    return `STAGED PM2 entry "${svcName}" in ${ecosystemPath}. Click APPLY — PM2 will start/restart the service automatically.`;
  }

  // Fall through to standard exec tools
  return runExecTool(name, args, staged);
}

function persistStagedRun(staged) {
  const dir = path.join(stagingRoot, staged.id);
  for (const f of staged.files) {
    if (f.content === '__DELETE__') continue; // deletions are metadata only
    const target = path.join(dir, 'files', stagingSlug(f.path));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, f.content);
  }
  fs.writeFileSync(
    path.join(dir, 'manifest.json'),
    JSON.stringify({
      id: staged.id, createdAt: new Date().toISOString(), prompt: staged.prompt,
      files: staged.files.filter(f => f.content !== '__DELETE__').map(f => ({ path: f.path, chars: f.content.length })),
      deletions: staged.files.filter(f => f.content === '__DELETE__').map(f => f.path),
      pm2Commands: staged.pm2Commands || []
    }, null, 2)
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
    const deleted = [];
    for (const f of manifest.files) {
      // f.path is an absolute path stored by runExecTool write_file
      const dest = resolveSafePath(f.path);
      if (!dest) continue;
      const slug = stagingSlug(f.path);
      const src = path.join(dir, 'files', slug);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, slug);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dest, bak);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      applied.push(dest);
    }
    // Handle staged deletions
    for (const p of (manifest.deletions || [])) {
      const dest = resolveSafePath(p);
      if (!dest) continue;
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, stagingSlug(p));
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dest, bak);
        fs.unlinkSync(dest);
        deleted.push(dest);
      }
    }
    // Run any PM2 commands that were staged alongside the files
    const pm2Results = [];
    for (const cmd of (manifest.pm2Commands || [])) {
      try {
        execSync(`pm2 start "${cmd.ecosystemPath}" --only "${cmd.name}"`, { encoding: 'utf8', timeout: 15_000 });
        pm2Results.push({ name: cmd.name, status: 'started' });
      } catch (pm2Err) {
        // Restart if already registered
        try {
          execSync(`pm2 restart "${cmd.name}"`, { encoding: 'utf8', timeout: 10_000 });
          pm2Results.push({ name: cmd.name, status: 'restarted' });
        } catch (restartErr) {
          pm2Results.push({ name: cmd.name, status: 'error', error: restartErr.message });
        }
      }
    }
    manifest.appliedAt = new Date().toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    sendJson(res, 200, { ok: true, applied, deleted, backupDir, pm2Results });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

function handleListDirs(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const reqPath = url.searchParams.get('path') || 'C:\\';
  // Normalize bare drive letters: 'C:' → 'C:\' so path.resolve returns the root, not process CWD
  const normalized = /^[A-Za-z]:$/.test(reqPath.trim()) ? reqPath.trim() + '\\' : reqPath;
  const abs = path.resolve(normalized);
  let dirs = [], files = [];
  try {
    const all = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of all) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch { /* unreadable — return empty */ }
  sendJson(res, 200, { path: abs, dirs, files });
}

async function handleBuildOrchestration(res, controller, prompt, histMsgs, ctxBlock, attachBlock = '', folderPaths = []) {
  sseWrite(res, '\n**[CLAUDE DIRECTOR → QWEN EXECUTOR]**\n\n');

  const staged = { id: `stage-${Date.now()}`, prompt, files: [], readPaths: new Set() };
  const recentHist = histMsgs.slice(-6).map(m => ({ role: m.role, content: String(m.content) }));

  // If folders are attached, walk them at depth 3 and show MCC root at depth 1 only
  let treeBlock;
  if (folderPaths.length) {
    const skip = new Set(['node_modules', '.git', 'dist', 'tmp', '.mav-console', '.venv', '__pycache__']);
    const lines = [];
    const walk = (dir, prefix, depth) => {
      if (depth > 3 || lines.length >= 150) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skip.has(e.name) || e.name.startsWith('.') || lines.length >= 150) continue;
        lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/', depth + 1);
      }
    };
    for (const fp of folderPaths) {
      lines.push(`[FOCUS] ${fp}`);
      walk(fp, '  ', 0);
    }
    lines.push(`\n[MCC ROOT] ${workspacePath}`);
    treeBlock = lines.join('\n');
  } else {
    treeBlock = workspaceTree();
  }

  const skillsBlock = loadSkills();

  // Query RAG for relevant coding reference before the director loop
  let ragRefBlock = '';
  try {
    const ragCtrl = new AbortController();
    const ragTimeout = setTimeout(() => ragCtrl.abort(), 8_000);
    const ragResp = await fetch(new URL('/estimate', ragUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ragCtrl.signal,
      body: JSON.stringify({ message: prompt, history: [], top_k: 6 })
    });
    clearTimeout(ragTimeout);
    if (ragResp.ok) {
      const ragData = await ragResp.json();
      const ref = (ragData.reply || '').trim();
      if (ref) ragRefBlock = `## Coding Reference (knowledge base)\n${ref}`;
    }
  } catch { /* RAG offline — continue without reference */ }

  const userContent = [
    treeBlock ? `Workspace file tree:\n${treeBlock}` : '',
    skillsBlock ? `## Loaded Skills\n\n${skillsBlock}` : '',
    ragRefBlock,
    attachBlock,
    `Request: ${prompt}`
  ].filter(Boolean).join('\n\n');

  const claudeMessages = [
    ...recentHist,
    { role: 'user', content: userContent }
  ];

  for (let round = 0; round < 20 && !controller.signal.aborted; round++) {
    let directive;
    try {
      directive = await callClaude(claudeMessages, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError') { res.write('data: [DONE]\n\n'); res.end(); return; }
      sseWrite(res, `[Claude error: ${err.message}]\n`);
      recordChatFailure('build', prompt, err);
      break;
    }

    if (directive.done) {
      if (directive.answer) sseWrite(res, `\n${directive.answer}\n`);
      else if (directive.summary) sseWrite(res, `\n${directive.summary}\n`);
      break;
    }

    // Claude needs more info before proceeding — show the question and stop
    if (directive.clarify) {
      sseWrite(res, `\n${directive.clarify}\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const task = directive.task;
    if (!task?.tool) { sseWrite(res, '[Unexpected Claude response — stopping]\n'); break; }

    const label = task.path || task.command || '';
    sseWrite(res, `→ ${task.tool}(${label}) `);

    let result;
    try {
      if (task.tool === 'write_file' || task.tool === 'delete_file') {
        sseWrite(res, '[Pi] ');
        result = await delegateToPi(task, controller.signal);
      } else {
        result = await runExecTool(task.tool, { path: task.path, command: task.command }, staged);
      }
    } catch (err) {
      if (err.name === 'AbortError') { res.write('data: [DONE]\n\n'); res.end(); return; }
      result = `ERROR: ${err.message}`;
    }

    const ok = !String(result).startsWith('ERROR') && !String(result).startsWith('REJECTED');
    sseWrite(res, `${ok ? '✓' : '✗'}\n`);
    if (ok && (task.tool === 'write_file' || task.tool === 'delete_file')) sseWrite(res, `  ${String(result).split('\n')[0]}\n`);

    // Tier 1 — ground truth check (always, free)
    let verification = '';
    if (task.tool === 'write_file' || task.tool === 'delete_file') {
      verification = verifyPiResult(task);
      sseWrite(res, `  ${verification}\n`);
    }

    // Tier 2 — code review (on demand, fast model)
    let reviewResult = '';
    if (task.review && task.tool === 'write_file' && verification.includes('CONFIRMED')) {
      sseWrite(res, `  [Review] `);
      reviewResult = await reviewPiOutput(task, controller.signal);
      const verdict = reviewResult.split('\n')[0];
      sseWrite(res, `${verdict}\n`);
      if (reviewResult.includes('RETRY')) sseWrite(res, `  ${reviewResult.split('\n')[1] || ''}\n`);
    }

    claudeMessages.push({ role: 'assistant', content: JSON.stringify(directive) });
    claudeMessages.push({
      role: 'user',
      content: `Result of ${task.tool}(${label}):\n${String(result).slice(0, 6000)}${verification ? '\n' + verification : ''}${reviewResult ? '\n' + reviewResult : ''}`
    });
  }

  if (controller.signal.aborted) { res.write('data: [DONE]\n\n'); res.end(); return; }

  res.write('data: [DONE]\n\n');
  res.end();
}

async function handleOpsOrchestration(res, controller, prompt, histMsgs, ctxBlock, attachBlock = '', folderPaths = []) {
  sseWrite(res, '\n**[MAVERICK OPS — CLAUDE ORCHESTRATOR]**\n\n');

  const staged = { id: `stage-${Date.now()}`, prompt, files: [], readPaths: new Set() };
  const recentHist = histMsgs.slice(-6).map(m => ({ role: m.role, content: String(m.content) }));

  // Build folder tree for attached paths
  let treeBlock = '';
  if (folderPaths.length) {
    const skip = new Set(['node_modules', '.git', 'dist', 'tmp', '.mav-console', '.venv', '__pycache__']);
    const lines = [];
    const walk = (dir, prefix, depth) => {
      if (depth > 3 || lines.length >= 120) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skip.has(e.name) || e.name.startsWith('.') || lines.length >= 120) continue;
        lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/', depth + 1);
      }
    };
    for (const fp of folderPaths) { lines.push(`[FOLDER] ${fp}`); walk(fp, '  ', 0); }
    treeBlock = `\nAttached folders:\n${lines.join('\n')}\n`;
  }

  const userContent = `${treeBlock}${attachBlock}\n${ctxBlock}\n\nRequest: ${prompt}`;
  const claudeMessages = [
    ...recentHist,
    { role: 'user', content: userContent }
  ];

  for (let round = 0; round < 25 && !controller.signal.aborted; round++) {
    let directive;
    try {
      directive = await callClaude(claudeMessages, controller.signal, CLAUDE_OPS_SYSTEM);
    } catch (err) {
      if (err.name === 'AbortError') { res.write('data: [DONE]\n\n'); res.end(); return; }
      sseWrite(res, `[Claude error: ${err.message}]\n`);
      recordChatFailure('ops', prompt, err);
      break;
    }

    if (directive.done) {
      if (directive.answer) sseWrite(res, `\n${directive.answer}\n`);
      else if (directive.summary) sseWrite(res, `\n${directive.summary}\n`);
      break;
    }

    if (directive.clarify) {
      sseWrite(res, `\n${directive.clarify}\n`);
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    const task = directive.task;
    if (!task?.tool) { sseWrite(res, '[Unexpected response — stopping]\n'); break; }

    const label = task.path || task.command || task.url || task.query || task.to || '';
    sseWrite(res, `→ ${task.tool}(${label}) `);

    let result;
    try {
      if (task.tool === 'write_file') {
        result = await delegateWriteToQwen(task, staged, controller);
      } else {
        result = await runOpsExecTool(task.tool, task, staged);
      }
    } catch (err) {
      if (err.name === 'AbortError') { res.write('data: [DONE]\n\n'); res.end(); return; }
      result = `ERROR: ${err.message}`;
    }

    const ok = !String(result).startsWith('ERROR') && !String(result).startsWith('REJECTED');
    sseWrite(res, `${ok ? '✓' : '✗'}\n`);

    claudeMessages.push({ role: 'assistant', content: JSON.stringify(directive) });
    claudeMessages.push({ role: 'user', content: `Result of ${task.tool}(${label}):\n${String(result).slice(0, 6000)}` });
  }

  if (controller.signal.aborted) { res.write('data: [DONE]\n\n'); res.end(); return; }

  if (staged.files.length) {
    persistStagedRun(staged);
    const nonDelete = staged.files.filter(f => f.content !== '__DELETE__');
    const toDelete = staged.files.filter(f => f.content === '__DELETE__');
    let stageMsg = `\n\n[STAGED:${staged.id}] `;
    if (nonDelete.length) stageMsg += `${nonDelete.length} file(s) ready: ${nonDelete.map(f => path.basename(f.path)).join(', ')}`;
    if (toDelete.length) stageMsg += `${nonDelete.length ? '; ' : ''}${toDelete.length} deletion(s): ${toDelete.map(f => path.basename(f.path)).join(', ')}`;
    stageMsg += '. Click APPLY when ready.\n';
    sseWrite(res, stageMsg);
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

async function runNimQc(staged, prompt, parentSignal) {
  try {
    let budget = 6000;
    const fileBlocks = staged.files.map((f) => {
      const part = f.content.slice(0, Math.max(0, budget));
      budget -= part.length;
      return `### ${path.basename(f.path)}\n${part}`;
    }).join('\n\n');

    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 28_000);
    const onParentAbort = () => ac.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    let r;
    try {
      r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST',
        signal: ac.signal,
        headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${nimApiKey}` },
        body: JSON.stringify({
          model: nimQcModel,
          messages: [
            { role: 'system', content: 'Senior code reviewer. Review staged changes for bugs and regressions. Be concise — 3-5 bullets max. End with SHIP or HOLD.' },
            { role: 'user', content: `Task: ${String(prompt).slice(0, 400)}\n\nStaged files:\n${fileBlocks}\n\nQC review:` }
          ],
          stream: true, temperature: 0.2, max_tokens: 350
        })
      });
    } finally {
      clearTimeout(timer);
      parentSignal.removeEventListener('abort', onParentAbort);
    }

    if (!r.ok) return `[QC failed: ${r.status} ${await r.text().catch(() => '')}]\n`;

    let out = '';
    await streamUpstream(r, (d) => { out += d; });
    return out + '\n';
  } catch (err) {
    if (err.name === 'AbortError') return '';
    return `[QC error: ${err.message}]\n`;
  }
}

// ASK mode — general conversational AI with homelab context
const CLAUDE_ASK_SYSTEM = `You are Maverick, Carter's personal AI assistant running inside the MCC Dashboard.

You know Carter's setup:
- CartersPC: Windows 11 Pro, Intel i5-13600K, RTX 4060 Ti 16GB, 64GB RAM. Workspace at C:\\Workspace\\Active\\.
- Homelab server (AIWA): HP ProDesk, i5-9500, 32GB RAM, 2TB NVMe + 500GB SATA, running Proxmox at 192.168.1.12.
- Services: RAG knowledge base (port 8181), Prometheus metrics (9090), local Qwen model (8080 via llama.cpp), Ollama (11434), Tailscale funnel for remote access.
- MCC Dashboard: Node.js server on port 3000, managed by PM2. Three modes: ASK (you), BUILD (coding agent), OPS (business assistant).
- SEO agents, download watcher, and mav-bridge are running as separate PM2 processes.

You're a general-purpose assistant. Help with:
- Homelab questions: Proxmox, networking, Docker, services, hardware
- Coding: architecture, debugging, code review, explaining concepts
- Research, analysis, writing, brainstorming — anything Carter needs
- Explaining how the MCC itself works (for BUILD or OPS questions, suggest switching mode)

Be direct and concise. No unnecessary preamble. Use the live dashboard context when it's relevant.`;

// Claude architect system prompt — senior dev director loop
// Claude directs one task at a time and sees results before deciding the next step.
const CLAUDE_ARCHITECT_SYSTEM = `You are the senior software developer at Maverick Integrations. Your job is to troubleshoot, debug, isolate, and direct code changes.

You work with Pi, a local coding agent who reads and writes files directly to disk — no staging, no review step. Changes are immediate. You direct, Pi executes.

Your workflow: analyze the problem → decide the next single action → output JSON → see the result → repeat until done.

You have read/write access to the entire filesystem except Windows system directories
(Windows\\, Program Files\\, System32\\, SysWOW64\\, AppData\\Local\\Temp, WindowsApps\\).
Attached folders and files from the user are always in scope.

The workspace tree below shows your current project and nearby directories. Use list_dir to explore
any path not listed — you have full access to navigate anywhere on any drive.
To discover what's available: {"task":{"tool":"list_dir","path":"C:\\\\"}} or {"task":{"tool":"list_dir","path":"D:\\\\"}}

Each response must be pure JSON — no prose, no markdown fences, one of:

Delegate a task:
{"task":{"tool":"read_file","path":"C:\\\\Workspace\\\\MyProject\\\\file.js"}}
{"task":{"tool":"list_dir","path":"C:\\\\Workspace\\\\MyProject"}}
{"task":{"tool":"list_dir","path":"D:\\\\"}}
{"task":{"tool":"run_command","command":"node --check server.mjs"}}
{"task":{"tool":"write_file","path":"C:\\\\Workspace\\\\MyProject\\\\file.js","instruction":"Exact description: which function, what to add/change/remove, and where. Be specific enough that a junior dev could do it mechanically."}}
{"task":{"tool":"write_file","path":"C:\\\\Workspace\\\\MyProject\\\\file.js","instruction":"...","review":true}}
{"task":{"tool":"delete_file","path":"C:\\\\Workspace\\\\MyProject\\\\old-file.js"}}

Ask for clarification before proceeding (use when critical info is missing):
{"clarify":"What trigger should start this agent — scheduled, file event, or manual?"}

Declare done (no file changes needed):
{"done":true,"answer":"Your direct answer or explanation to the user"}

Propose a plan for user confirmation (agent creation, large changes):
{"done":true,"answer":"Here is the proposed agent:\\n\\n\`\`\`markdown\\n# Agent: ...\\n\`\`\`\\n\\nShould I create this at [path]? Reply yes to proceed."}

Declare done (files were changed):
{"done":true,"summary":"What was built or changed, the exact file path(s), and how to run or test it — 2-3 sentences"}

## Creating Maverick Agents

When the user asks you to create, build, or make an agent:
1. If purpose, trigger, or target folder is unclear — use clarify first.
2. Once you have enough info — propose the full .md content with done+answer. Do NOT write yet.
3. When the user replies yes/confirmed/looks good — then write_file via Pi.

Maverick agents are .md files. The format:

\`\`\`
# Agent: [Name]

## Purpose
[One sentence — what this agent does and why]

## Trigger
[When it runs — e.g. "Manual", "Scheduled daily at 9am", "Event: new file in Downloads"]

## Instructions
1. [Step one]
2. [Step two]
...

## Tools
[list_dir / read_file / run_command / Gmail API / Puppeteer / etc.]

## Output
[What it produces — e.g. "Slack notification", "Email reply", "Updated spreadsheet"]
\`\`\`

Agent file naming: kebab-case. Examples: monitor-invoices.md, daily-voicemail-check.md
Agent folder: use the attached folder path if provided, otherwise ask.

## Creating Maverick Skills

Skills are reusable step-by-step procedures that YOU (Claude) follow when doing specific tasks. They live in the MCC skills/ folder (${skillsPath}) and are automatically loaded into your context on every BUILD request.

When the user asks you to create a skill:
1. If purpose or trigger is unclear — use clarify first.
2. Propose the full skill .md with done+answer — do NOT write yet.
3. When the user confirms — write_file to the skills/ folder via Pi.

Skills format:
\`\`\`
# Skill: [Name]

## Trigger
[When to apply this skill — what the user says or what task type triggers it]

## Procedure
1. [Exact step Claude should take]
2. [Next step — include tool names, paths, naming conventions]
...

## Output
[What gets created or changed — file paths, formats, expected result]

## Notes
[Gotchas, constraints, things to check or verify]
\`\`\`

Skill file naming: kebab-case. Examples: create-agent.md, deploy-pm2-service.md, add-api-endpoint.md
Skill folder: always ${skillsPath}

When Loaded Skills appear in your context above, read them and follow their procedures precisely for matching tasks.

## Build From Scratch Protocol

Use this when the request is to build a new app, new project, or a major feature that does not yet exist.
Do NOT use for bug fixes, quick edits, or single-file changes — those go straight to tasks.

**Default stack — never ask about this:**
Next.js (TypeScript) + Supabase + Vercel + Tailwind CSS + shadcn/ui.
Use this unless the user explicitly names a different technology. Do not ask "what stack do you prefer?" — assume the default.

**How to tell which mode:**
- "build me a...", "create an app that...", "make a new project..." → planning mode
- "fix this bug", "update this file", "add X to Y" → skip planning, execute directly

### Phase 1 — Conception (gather requirements)

Ask the user questions using clarify. You can group related questions into one clarify response.
Ask only what you need to build a complete spec — do not over-ask.
Do NOT ask about the tech stack — it is already defined above.

Cover:
- What problem does it solve / what does it do?
- Who uses it? (just you, end users, internal tool?)
- What are the 3–5 must-have features for the first version?
- What is explicitly out of scope?
- Where does it live? (standalone app, new page in existing project, CLI tool?)
- What integrations are required? (APIs, databases, auth, third-party services)

If the user's initial message already answers most of these, write the spec yourself and ask for confirmation instead of asking individually.

### Phase 2 — Plan (design before building)

Once you have enough information, produce a full plan. You MUST wrap it in a done+answer JSON object — do not output raw text.

Output exactly this structure (the plan text goes inside the "answer" string value):
{"done":true,"answer":"SPEC:\n  Goal: [one sentence]\n  Users: [who]\n  MVP features:\n    1. [feature]\n    2. [feature]\n  Out of scope: [list]\n  Stack: Next.js, Supabase, Vercel, Tailwind, shadcn/ui\n\nARCHITECTURE:\n  Data model: [tables and columns]\n  Routes: [list]\n  API endpoints: [method + path + purpose]\n  Env vars: [VAR_NAME - description]\n\nIMPLEMENTATION ORDER:\n  1. [first step]\n  2. [second step]\n\nReply 'build it' to start execution."}

The entire response must be one JSON object. Never output the plan as raw text outside of JSON.

### Phase 3 — Execution (after confirmation)

When the user replies with "build it", "go ahead", "looks good", "confirmed", or similar:
- Work through the implementation order from the plan, one task at a time
- Add "review":true on every new file with real logic
- Follow the normal execution loop: one task → wait for result → next task

## General Rules
- One task per response. Wait for the result before deciding the next task.
- Use absolute paths (e.g. C:\\Workspace\\...) whenever possible.
- Always read_file before write_file on the same path.
- For write_file: "instruction" must be exact — location, function name, what changes. Pi is mechanical.
- Add "review":true on write_file when the task is complex: new files with real logic, architectural changes, multi-step features, anything where correctness matters. Omit for trivial edits (typo fix, adding a comment, simple one-liner addition).
- When review returns RETRY: issue a new write_file with a more specific instruction addressing the reason.
- For simple info requests: read the file and declare done with an answer. Do not write anything.
- Be surgical. Never touch files unrelated to the problem.
- When the problem is fully resolved or the question is answered, declare done.
- NEVER use run_command to start a dev server (npm run dev, npm start, next dev, vite, nodemon). These are long-running processes that block forever. Starting the app is the user's job, not yours.
- When building a new Next.js app, always set the dev script in package.json to use port 3001 or higher (e.g. "dev": "next dev -p 3001") — port 3000 is reserved for the MCC dashboard.`;

// OPS mode orchestrator prompt — personal assistant with full tool suite
const CLAUDE_OPS_SYSTEM = `You are Maverick's personal operations assistant for Maverick Integrations.
You orchestrate tasks in an agentic loop — you decide one action at a time, see the result, then decide the next.
This is an INTERNAL protocol. Your JSON directives are NEVER shown to the user. The user only sees your final answer or summary.

Output pure JSON — one directive per response, no prose, no markdown fences:

Standard tools:
{"task":{"tool":"list_dir","path":"C:\\\\Workspace\\\\MyProject"}}
{"task":{"tool":"read_file","path":"C:\\\\Workspace\\\\docs\\\\notes.md"}}
{"task":{"tool":"write_file","path":"C:\\\\Workspace\\\\agents\\\\monitor.md","instruction":"Write a complete agent definition file with the following content..."}}
{"task":{"tool":"run_command","command":"python scripts\\\\process.py"}}
{"task":{"tool":"fetch_url","url":"https://example.com/api/data"}}
{"task":{"tool":"web_search","query":"best practices for invoice tracking"}}

Document tools:
{"task":{"tool":"read_docx","path":"C:\\\\Workspace\\\\Proposals\\\\quote.docx"}}
{"task":{"tool":"read_pdf","path":"C:\\\\Workspace\\\\Contracts\\\\agreement.pdf"}}
{"task":{"tool":"read_xlsx","path":"C:\\\\Workspace\\\\Reports\\\\jobs.xlsx","sheet":"Sheet1"}}
{"task":{"tool":"write_xlsx","path":"C:\\\\Workspace\\\\Reports\\\\monthly.xlsx","sheets":[{"name":"Jobs","headers":["Date","Client","Amount"],"rows":[["2025-01-15","Acme Corp","1200"]]}]}}
{"task":{"tool":"write_csv","path":"C:\\\\Workspace\\\\exports\\\\data.csv","headers":["Name","Value"],"rows":[["item1","100"]]}}
{"task":{"tool":"read_csv","path":"C:\\\\Workspace\\\\data\\\\records.csv"}}

Email tools (requires EMAIL_IMAP_HOST and EMAIL_SMTP_HOST in .env):
{"task":{"tool":"list_emails","mailbox":"INBOX","limit":20}}
{"task":{"tool":"search_emails","query":"invoice overdue","limit":10}}
{"task":{"tool":"read_email","uid":"12345"}}
{"task":{"tool":"send_email","to":"client@example.com","subject":"Follow-up on Proposal","body":"Hi,\\n\\nJust following up...\\n\\nBest,\\nMaverick Integrations"}}
{"task":{"tool":"create_draft","to":"partner@example.com","subject":"Meeting Tomorrow","body":"Hi,\\n\\nAre you available..."}}
{"task":{"tool":"label_email","uid":"12345","label":"Invoices"}}

File management:
{"task":{"tool":"move_file","from":"C:\\\\Workspace\\\\old.txt","to":"C:\\\\Workspace\\\\archive\\\\old.txt"}}
{"task":{"tool":"copy_file","from":"C:\\\\Workspace\\\\template.docx","to":"C:\\\\Workspace\\\\Projects\\\\NewProject\\\\proposal.docx"}}
{"task":{"tool":"delete_file","path":"C:\\\\Workspace\\\\temp\\\\scratch.txt"}}

Analysis:
{"task":{"tool":"analyze_image","path":"C:\\\\Workspace\\\\photos\\\\site.jpg"}}

Agent & skill creation:
{"task":{"tool":"create_agent","path":"C:\\\\Workspace\\\\agents\\\\invoice-monitor.md","content":"# Agent: Invoice Monitor\\n\\n## Purpose\\nMonitor inbox for invoices..."}}
{"task":{"tool":"create_skill","path":"${skillsPath}\\\\write-proposal.md","content":"# Skill: Write Proposal\\n\\n## Trigger\\nUser asks to create or draft a proposal..."}}
{"task":{"tool":"deploy_pm2","script":"C:\\\\Workspace\\\\agents\\\\invoice-monitor.mjs","name":"invoice-monitor","cwd":"C:\\\\Workspace\\\\agents"}}

Control flow:
{"clarify":"Which folder should I save the report to?"}
{"done":true,"answer":"Here is the summary of your inbox: ..."}
{"done":true,"summary":"Created spreadsheet with 42 rows at C:\\\\Workspace\\\\Reports\\\\monthly.xlsx and sent follow-up email to 3 clients."}

## Agent Creation Protocol
1. If purpose, trigger, or save location is unclear — clarify first
2. Propose full .md content via done+answer — do NOT write yet
3. When user confirms → use create_agent tool to write the file (staged for APPLY)

Agent format:
# Agent: [Name]
## Purpose / ## Trigger / ## Instructions (numbered) / ## Tools / ## Output / ## Schedule (if recurring)

## Skill Creation Protocol
1. Skills auto-load on every BUILD/OPS session from the skills/ folder
2. Propose skill content via done+answer first, then write on confirmation
3. Use create_skill tool pointing to ${skillsPath}

## General Rules
- One task per response. Wait for the result before the next.
- Use absolute paths always.
- Always read_file or read_docx/read_pdf before writing or editing documents.
- For emails: list_emails or search_emails first to find UIDs, then read_email for full content.
- Never delete files without first asking via clarify — use delete_file only after confirmation.
- When done, declare done with a clear summary of what was accomplished.`;

function buildChatSseWrite(res, event) {
  res.write(`data: ${JSON.stringify(event)}\n\n`);
}

// Extracts the first balanced JSON object from a string.
// Handles nested objects, curly braces inside strings, and escape sequences.
// More reliable than a greedy regex when the model includes extra text or multiple objects.
function extractJsonObject(text) {
  let depth = 0, start = -1, inString = false, escape = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && start !== -1) return text.slice(start, i + 1);
    }
  }
  return null;
}

async function callGpt4o(messages, signal, systemPrompt) {
  const sys = systemPrompt || CLAUDE_ARCHITECT_SYSTEM;
  const gptMessages = [
    { role: 'system', content: sys },
    ...messages
  ];
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${openAiApiKey}` },
    body: JSON.stringify({ model: 'gpt-4o', messages: gptMessages, temperature: 0.2, max_tokens: 2048 })
  });
  if (!r.ok) throw new Error(`GPT-4o ${r.status}: ${await r.text().catch(() => '')}`);
  const payload = await r.json();
  const text = payload.choices?.[0]?.message?.content?.trim() || '';
  const json = extractJsonObject(text);
  if (!json) {
    // Model output prose instead of JSON — surface it as a done+answer so the user sees it
    console.warn('[GPT-4o] non-JSON response, wrapping as done+answer:', text.slice(0, 120));
    return { done: true, answer: text };
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn('[GPT-4o] extracted JSON failed to parse, wrapping full text:', err.message);
    return { done: true, answer: text };
  }
}

async function callClaude(messages, signal, systemPrompt) {
  const sys = systemPrompt || CLAUDE_ARCHITECT_SYSTEM;
  const hasKey = anthropicApiKey && anthropicApiKey.length >= 10 && anthropicApiKey.startsWith('sk-ant');
  if (!hasKey) return callGpt4o(messages, signal, sys);

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: anthropicModel,
        system: sys,
        messages,
        max_tokens: 2048,
        temperature: 0.2
      })
    });
    if (!r.ok) {
      const errText = await r.text().catch(() => '');
      console.warn(`[planner] Claude ${r.status} — falling back to GPT-4o: ${errText.slice(0, 120)}`);
      return callGpt4o(messages, signal, sys);
    }
    const payload = await r.json();
    const text = payload.content?.[0]?.text?.trim() || '';
    const json = extractJsonObject(text);
    if (!json) {
      console.warn('[Claude] non-JSON response, wrapping as done+answer:', text.slice(0, 120));
      return { done: true, answer: text };
    }
    try {
      return JSON.parse(json);
    } catch (e) {
      console.warn('[Claude] extracted JSON failed to parse, wrapping full text:', e.message);
      return { done: true, answer: text };
    }
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn(`[planner] Claude error — falling back to GPT-4o: ${err.message}`);
    return callGpt4o(messages, signal, sys);
  }
}

// ── Pi RPC (BUILD executor) ────────────────────────────────────────────────

function callPiRpc(prompt, signal) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn(piExecutable, ['--mode', 'rpc', '--no-session', '--model', piModel], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        shell: process.platform === 'win32',
      });
    } catch (err) {
      return reject(new Error(`Failed to spawn Pi: ${err.message}`));
    }

    let textBuffer = '';
    let settled = false;

    const finish = (err) => {
      if (settled) return;
      settled = true;
      try { proc.kill(); } catch {}
      if (err) reject(err);
      else resolve(textBuffer.trim());
    };

    if (signal) signal.addEventListener('abort', () => finish(Object.assign(new Error('Aborted'), { name: 'AbortError' })), { once: true });

    proc.stdout.on('data', (chunk) => {
      for (const line of chunk.toString().split('\n')) {
        if (!line.trim()) continue;
        let event;
        try { event = JSON.parse(line); } catch { continue; }
        if (event.type === 'message_update') {
          const ev = event.assistantMessageEvent;
          if (ev?.type === 'text_delta') textBuffer += ev.delta;
        }
        if (event.type === 'agent_end') finish(null);
        if (event.type === 'response' && event.success === false) finish(new Error(event.error || 'Pi RPC error'));
      }
    });

    proc.stderr.on('data', (chunk) => console.warn('[Pi RPC]', chunk.toString().trim()));
    proc.on('close', () => finish(null));
    proc.on('error', (err) => finish(new Error(`Pi spawn error: ${err.message}`)));

    proc.stdin.write(JSON.stringify({ type: 'prompt', message: prompt }) + '\n');
  });
}

// ── Tier 1: ground-truth existence check (always, free) ───────────────────

function verifyPiResult(task) {
  if (task.tool === 'write_file') {
    try {
      const { size } = fs.statSync(task.path);
      return size > 0
        ? `[Verify] CONFIRMED — file exists (${size} bytes)`
        : '[Verify] FAILED — file exists but is empty';
    } catch {
      return '[Verify] FAILED — file not found on disk after Pi reported success';
    }
  }
  if (task.tool === 'delete_file') {
    return fs.existsSync(task.path)
      ? '[Verify] FAILED — file still exists on disk'
      : '[Verify] CONFIRMED — file is gone';
  }
  return '';
}

// ── Tier 2: fast code review (on demand, NIM 8B → GPT-4o-mini fallback) ──

async function reviewPiOutput(task, signal) {
  let content;
  try { content = fs.readFileSync(task.path, 'utf8').slice(0, 4000); }
  catch { return 'VERDICT: WARN\nREASON: Could not read file for review.'; }

  const reviewPrompt = `You are a senior code reviewer for a Next.js App Router project (TypeScript, Tailwind, shadcn/ui, Supabase). A coding agent just wrote this file. Review it for correctness and whether it will actually run.

Task instruction: ${task.instruction}
File: ${task.path}

Content:
${content}

Check specifically:
- If the file uses React hooks (useState, useEffect, etc.) or browser APIs (window, document, Notification), it MUST have "use client" as the very first line. Missing this = RETRY.
- Named exports must match how they are imported elsewhere. A default export cannot be imported as a named export. Wrong export shape = RETRY.
- File extension must match content: JSX/TSX syntax requires .tsx, plain TS requires .ts. Wrong extension = RETRY.
- Import paths must be correct relative to the file's location (./foo for same dir, ../foo for parent).
- No placeholder logic, hardcoded mock data passed off as real, or unimplemented stubs unless the task explicitly asked for mocks.

Reply in EXACTLY this format (2 lines, nothing else):
VERDICT: PASS | WARN | RETRY
REASON: One sentence.

PASS = correct, will run as-is. WARN = works but has notable issues. RETRY = will not run or is structurally wrong.`;

  const body = { messages: [{ role: 'user', content: reviewPrompt }], temperature: 0.1, max_tokens: 150, stream: false };

  if (nimApiKey) {
    try {
      const r = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${nimApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: nimQcModel }),
      });
      if (r.ok) {
        const d = await r.json();
        const text = d.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {}
  }

  if (openAiApiKey) {
    try {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST', signal: AbortSignal.timeout(20_000),
        headers: { Authorization: `Bearer ${openAiApiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...body, model: 'gpt-4o-mini' }),
      });
      if (r.ok) {
        const d = await r.json();
        const text = d.choices?.[0]?.message?.content?.trim();
        if (text) return text;
      }
    } catch {}
  }

  return 'VERDICT: WARN\nREASON: No review model available.';
}

async function delegateToPi(task, signal) {
  // delete_file is handled server-side — Pi's bash uses `rm` which silently fails on Windows
  if (task.tool === 'delete_file') {
    fs.unlinkSync(task.path);
    return `Deleted ${task.path}`;
  }
  const piPrompt = `You are a code editor executing a precise file change.\n\nFile: ${task.path}\nInstruction: ${task.instruction}\n\nSteps:\n1. Read the file at the exact path above using your read tool\n2. Apply the instruction — change only what is specified, preserve everything else\n3. Write the updated file back to the same path\n4. Reply with 1-2 sentences describing what you changed.\n\nExecute now. Do not ask questions.`;
  return await callPiRpc(piPrompt, signal);
}

// ── Qwen HTTP delegate (OPS only) ─────────────────────────────────────────

async function delegateWriteToQwen(task, staged, controller) {
  // Qwen receives the current file + Claude's precise instruction and produces the full updated file
  const currentContent = staged.readPaths.has(task.path)
    ? (staged.files.find(f => f.path === task.path)?.content ?? null)
    : null;

  const readStaged = { id: staged.id, prompt: staged.prompt, files: staged.files, readPaths: staged.readPaths };
  const fileContent = currentContent ?? await runExecTool('read_file', { path: task.path }, readStaged);

  const qwenMessages = [
    {
      role: 'system',
      content: `You are a code editor. You receive a file and a precise instruction. You output ONLY the complete updated file — no explanation, no markdown fences, no commentary.`
    },
    {
      role: 'user',
      content: `File: ${task.path}\n\nCurrent content:\n${fileContent}\n\nInstruction: ${task.instruction}\n\nOutput the complete updated file:`
    }
  ];

  const r = await fetch(new URL('/v1/chat/completions', llamaServerUrl), {
    method: 'POST',
    signal: controller.signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: localModel,
      messages: qwenMessages,
      stream: false,
      temperature: 0.1,
      max_tokens: 4000
    })
  });
  const payload = await r.json();
  if (!r.ok) throw new Error(payload?.error?.message || `Qwen status ${r.status}`);
  const newContent = payload.choices?.[0]?.message?.content?.trim() || '';
  // Strip any accidental markdown fences Qwen might add
  const stripped = newContent.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  return await runExecTool('write_file', { path: task.path, content: stripped }, staged);
}

async function handleBuildChat(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch {
    sendJson(res, 400, { error: 'Invalid JSON body.' });
    return;
  }

  const { prompt, history = [], attachments = [] } = body || {};
  if (!String(prompt || '').trim()) {
    sendJson(res, 400, { error: 'Prompt is required.' });
    return;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    'connection': 'keep-alive',
    'x-accel-buffering': 'no'
  });

  const controller = new AbortController();
  req.on('close', () => controller.abort());
  const done = () => { res.write('data: [DONE]\n\n'); res.end(); };

  const staged = { id: `stage-${Date.now()}`, prompt: String(prompt).trim(), files: [], readPaths: new Set() };

  // Build file context only from paths the user explicitly attached — no auto-scan
  const rawAttachments = (Array.isArray(attachments) ? attachments : [])
    .filter(a => a?.type === 'folder' || a?.type === 'file');
  const attachedPaths = [];
  const blockedPaths = [];
  for (const a of rawAttachments) {
    const resolved = resolveSafePath(a.path);
    if (resolved) attachedPaths.push({ type: a.type, path: resolved });
    else blockedPaths.push(a.path);
  }
  if (blockedPaths.length) {
    buildChatSseWrite(res, { type: 'warning', text: `⚠ ${blockedPaths.length} attachment(s) could not be resolved: ${blockedPaths.join(', ')}` });
  }

  let treeContext = '';
  const folderPaths = attachedPaths.filter(a => a.type === 'folder').map(a => a.path);
  const filePaths = attachedPaths.filter(a => a.type === 'file').map(a => a.path);

  if (folderPaths.length || filePaths.length) {
    const lines = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'tmp', '.mav-console', '.venv', '__pycache__']);
    const walk = (dir, prefix, depth) => {
      if (depth > 3 || lines.length >= 150) return;
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const e of entries) {
        if (skip.has(e.name) || e.name.startsWith('.') || lines.length >= 150) continue;
        lines.push(prefix + e.name + (e.isDirectory() ? '/' : ''));
        if (e.isDirectory()) walk(path.join(dir, e.name), prefix + e.name + '/', depth + 1);
      }
    };
    for (const fp of folderPaths) {
      lines.push(`[FOLDER] ${fp}`);
      walk(fp, '  ', 0);
    }
    if (filePaths.length) {
      lines.push(`\n[FILES]`);
      for (const fp of filePaths) {
        lines.push(`  ${fp}`);
      }
    }
    treeContext = `Attached context:\n${lines.join('\n')}\n\n`;
  }

  const histMsgs = (Array.isArray(history) ? history : [])
    .slice(-8)
    .filter(m => (m.role === 'user' || m.role === 'assistant') && String(m.content || '').trim())
    .map(m => ({ role: m.role, content: String(m.content) }));

  // Query RAG for relevant coding reference before the director loop
  let ragRefBlock = '';
  try {
    const ragCtrl = new AbortController();
    const ragTimeout = setTimeout(() => ragCtrl.abort(), 8_000);
    const ragResp = await fetch(new URL('/estimate', ragUrl), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: ragCtrl.signal,
      body: JSON.stringify({ message: String(prompt).trim(), history: [], top_k: 6 })
    });
    clearTimeout(ragTimeout);
    if (ragResp.ok) {
      const ragData = await ragResp.json();
      const ref = (ragData.reply || '').trim();
      if (ref) ragRefBlock = `\n\n## Coding Reference (knowledge base)\n${ref}`;
    }
  } catch { /* RAG offline — continue without reference */ }

  const claudeMessages = [
    ...histMsgs,
    { role: 'user', content: `${treeContext}${ragRefBlock ? ragRefBlock + '\n\n' : ''}Request: ${String(prompt).trim()}` }
  ];

  buildChatSseWrite(res, { type: 'status', text: 'Claude is analyzing...' });

  // Director/executor loop — Claude decides one task at a time, sees results, iterates
  for (let round = 0; round < 20 && !controller.signal.aborted; round++) {
    let directive;
    try {
      directive = await callClaude(claudeMessages, controller.signal);
    } catch (err) {
      if (err.name === 'AbortError') { done(); return; }
      buildChatSseWrite(res, { type: 'status', text: `Claude error: ${err.message}` });
      done(); return;
    }

    // Done — no file changes
    if (directive.done && directive.answer) {
      buildChatSseWrite(res, { type: 'token', text: directive.answer });
      done(); return;
    }

    // Done — files were changed
    if (directive.done) {
      if (staged.files.length) {
        persistStagedRun(staged);
        buildChatSseWrite(res, { type: 'staged', id: staged.id, files: staged.files.map(f => f.path) });

        // NIM QC
        if (nimApiKey) {
          buildChatSseWrite(res, { type: 'status', text: 'NIM is verifying...' });
          try {
            let budget = 8000;
            const fileBlocks = staged.files.map(f => {
              const part = f.content.slice(0, Math.max(0, budget));
              budget -= part.length;
              return `### ${f.path}\n${part}`;
            }).join('\n\n');
            const qcRes = await fetch('https://integrate.api.nvidia.com/v1/chat/completions', {
              method: 'POST',
              signal: AbortSignal.any([controller.signal, AbortSignal.timeout(45_000)]),
              headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${nimApiKey}` },
              body: JSON.stringify({
                model: nimModel,
                messages: [
                  { role: 'system', content: 'Senior code reviewer. Review these staged changes for bugs and regressions. 3-5 bullets max. End with SHIP or HOLD.' },
                  { role: 'user', content: `Request: ${String(prompt).trim()}\n\nStaged files:\n${fileBlocks}\n\nQC:` }
                ],
                stream: false, temperature: 0.2, max_tokens: 400
              })
            });
            if (qcRes.ok) {
              const qcPayload = await qcRes.json();
              const qcText = qcPayload.choices?.[0]?.message?.content?.trim();
              if (qcText) buildChatSseWrite(res, { type: 'qc', text: qcText });
            } else {
              buildChatSseWrite(res, { type: 'status', text: `NIM QC failed: ${qcRes.status}` });
            }
          } catch (err) {
            if (err.name === 'TimeoutError') buildChatSseWrite(res, { type: 'status', text: 'NIM QC timed out — review staged files manually.' });
          }
        }
      }
      if (directive.summary) buildChatSseWrite(res, { type: 'token', text: directive.summary });
      done(); return;
    }

    // Execute the delegated task
    const task = directive.task;
    if (!task?.tool) {
      buildChatSseWrite(res, { type: 'status', text: 'Claude returned unexpected format — stopping.' });
      done(); return;
    }

    const label = task.path || task.command || '';
    const toolVerb = { read_file: 'Reading', list_dir: 'Listing', write_file: 'Writing', run_command: 'Running' }[task.tool] || task.tool;
    buildChatSseWrite(res, { type: 'status', text: `Claude → ${toolVerb} ${label}` });

    let result;
    try {
      if (task.tool === 'write_file' || task.tool === 'delete_file') {
        buildChatSseWrite(res, { type: 'status', text: `Pi → ${task.tool === 'delete_file' ? 'deleting' : 'writing'} ${label}` });
        result = await delegateToPi(task, controller.signal);
      } else {
        result = await runExecTool(task.tool, { path: task.path, command: task.command }, staged);
      }
    } catch (err) {
      if (err.name === 'AbortError') { done(); return; }
      result = `ERROR: ${err.message}`;
    }

    const ok = !String(result).startsWith('ERROR') && !String(result).startsWith('REJECTED');
    buildChatSseWrite(res, { type: 'action', tool: task.tool, path: label, ok });
    if (ok && (task.tool === 'write_file' || task.tool === 'delete_file')) {
      buildChatSseWrite(res, { type: 'token', text: String(result).split('\n')[0] });
    }

    // Tier 1 — ground truth (always, free)
    let verification = '';
    if (task.tool === 'write_file' || task.tool === 'delete_file') {
      verification = verifyPiResult(task);
      buildChatSseWrite(res, { type: 'status', text: verification });
    }

    // Tier 2 — code review (on demand, fast model)
    let reviewResult = '';
    if (task.review && task.tool === 'write_file' && verification.includes('CONFIRMED')) {
      buildChatSseWrite(res, { type: 'status', text: '[Review] running...' });
      reviewResult = await reviewPiOutput(task, controller.signal);
      buildChatSseWrite(res, { type: 'status', text: `[Review] ${reviewResult.split('\n')[0]}` });
      if (reviewResult.includes('RETRY')) {
        buildChatSseWrite(res, { type: 'status', text: reviewResult.split('\n')[1] || '' });
      }
    }

    // Feed result back to Claude
    claudeMessages.push({ role: 'assistant', content: JSON.stringify(directive) });
    claudeMessages.push({
      role: 'user',
      content: `Result of ${task.tool}(${label}):\n${String(result).slice(0, 6000)}${verification ? '\n' + verification : ''}${reviewResult ? '\n' + reviewResult : ''}`
    });
  }

  // Hit round limit
  buildChatSseWrite(res, { type: 'status', text: 'Round limit reached.' });
  done();
}

async function handleChat(req, res) {
  try {
    const { prompt, mode = 'ask', history = [], attachments = [] } = await readJsonBody(req);
    if (!prompt?.trim()) {
      sendJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    // Folder attachments — resolve paths server-side, no content upload needed
    const folderPaths = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a?.type === 'folder' && typeof a.path === 'string')
      .map((a) => resolveSafePath(a.path))
      .filter(Boolean)
      .slice(0, 5);

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
    if (folderPaths.length) {
      attachBlock += `\n\n--- ATTACHED FOLDERS (use list_dir/read_file to explore) ---\n${folderPaths.join('\n')}\n--- END FOLDERS ---`;
    }

    const dashCtx = await buildDashboardContext();
    const ctxBlock = `\n\n--- LIVE DASHBOARD CONTEXT ---\n${dashCtx}\n--- END CONTEXT ---`;

    const systemPrompts = {
      ask:  CLAUDE_ASK_SYSTEM  + ctxBlock,
      build: CLAUDE_ARCHITECT_SYSTEM + ctxBlock,
      ops:   CLAUDE_OPS_SYSTEM + ctxBlock,
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

    // BUILD → Claude director → Qwen executor → NIM QC
    if (mode === 'build') {
      await handleBuildOrchestration(res, controller, prompt.trim(), histMsgs, ctxBlock, attachBlock, folderPaths);
      return;
    }

    // OPS → Claude orchestrator → ops tool executor
    if (mode === 'ops') {
      await handleOpsOrchestration(res, controller, prompt.trim(), histMsgs, ctxBlock, attachBlock, folderPaths);
      return;
    }

    // ASK → RAG first (12s timeout), Qwen fallback for general questions
    if (mode === 'ask') {
      let ragOk = false;
      try {
        const ragCtrl = new AbortController();
        const ragTimeout = setTimeout(() => ragCtrl.abort(), 12_000);
        const ragResp = await fetch(new URL('/estimate', ragUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ragCtrl.signal,
          body: JSON.stringify({ message: prompt.trim(), history: histMsgs, top_k: 12 })
        });
        clearTimeout(ragTimeout);
        if (ragResp.ok) {
          const ragData = await ragResp.json();
          const reply = (ragData.reply || '').trim();
          if (reply) {
            ragOk = true;
            sseWrite(res, reply);
          }
        }
      } catch { /* RAG offline or timed out — fall through */ }

      if (!ragOk) {
        // Claude fallback (→ GPT-4o if no key), then Qwen if both unavailable
        const msgs = [
          ...histMsgs,
          { role: 'user', content: prompt.trim() + (attachBlock ? '\n\n' + attachBlock : '') }
        ];
        let claudeOk = false;
        try {
          const directive = await callClaude(msgs, controller.signal, system);
          const reply = directive.answer || directive.summary || (typeof directive === 'string' ? directive : '');
          if (reply) { sseWrite(res, reply); claudeOk = true; }
        } catch (cErr) {
          if (cErr.name === 'AbortError') { if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); } return; }
        }

        if (!claudeOk) {
          // Qwen last-resort: local model when both RAG and Claude are unavailable
          const qMsgs = [
            { role: 'system', content: system },
            ...histMsgs,
            { role: 'user', content: prompt.trim() }
          ];
          try {
            const upstream = await fetch(new URL('/v1/chat/completions', llamaServerUrl), {
              method: 'POST',
              signal: controller.signal,
              headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
              body: JSON.stringify({ model: localModel, messages: qMsgs, stream: true, temperature: 0.7, max_tokens: 1400 })
            });
            if (upstream.ok) {
              const reader = upstream.body.getReader();
              const decoder = new TextDecoder();
              try {
                while (true) {
                  const { done, value } = await reader.read();
                  if (done) break;
                  if (!res.writable) break;
                  res.write(decoder.decode(value, { stream: true }));
                }
              } finally { reader.releaseLock(); }
            } else {
              sseWrite(res, '[All backends offline — please try again]');
              recordChatFailure('ask', prompt, `RAG + Claude offline, Qwen ${upstream.status}`);
            }
          } catch (qErr) {
            if (qErr.name !== 'AbortError') {
              sseWrite(res, `[Error: ${qErr.message}]`);
              recordChatFailure('ask', prompt, qErr);
            }
          }
        }
      }

      if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
      return;
    }

    // REVIEW → Gemini Flash (if key set), otherwise Qwen
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
      recordChatFailure(mode || 'ask', prompt || '', error);
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
  'https://carterspc.tailf72e3f.ts.net',
  'http://localhost:5173',
  'http://localhost:3011',
];

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  // CORS — allow Vercel frontend, Tailscale Funnel, and local dev
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || origin.endsWith('.vercel.app') || origin.endsWith('.ts.net')) {
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
  if (url.pathname === '/api/rag' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const upstream = await fetch(new URL('/estimate', ragUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      clearTimeout(timeout);
      const data = await upstream.json();
      sendJson(res, upstream.status, data);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }
  if (url.pathname === '/api/rag/ask' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 30_000);
      const upstream = await fetch(new URL('/ask', ragUrl), {
        method: 'POST',
        signal: controller.signal,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
      });
      clearTimeout(timeout);
      const data = await upstream.json();
      sendJson(res, upstream.status, data);
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
    return;
  }
  if (url.pathname === '/api/rag/stats') {
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 3000);
      const upstream = await fetch(new URL('/stats', ragUrl), { signal: controller.signal });
      sendJson(res, upstream.status, await upstream.json());
    } catch (err) {
      sendJson(res, 502, { error: err.message });
    }
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
  if (url.pathname === '/api/workflows/seo/posts/week') {
    sendJson(res, 200, await callRepoBridge('/seo/posts/week', { timeoutMs: 10_000 }));
    return;
  }
  if (url.pathname === '/api/workflows/seo/facebook/pending-prompt') {
    sendJson(res, 200, await callRepoBridge('/seo/facebook/pending-prompt', { timeoutMs: 5_000 }));
    return;
  }
  if (url.pathname === '/api/workflows/seo/facebook/approve-prompt' && req.method === 'POST') {
    const body = await readJsonBody(req);
    sendJson(res, 200, await callRepoBridge('/seo/facebook/approve-prompt', {
      method: 'POST', body, timeoutMs: 5_000,
    }));
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
  if (url.pathname === '/api/build-chat' && req.method === 'POST') {
    await handleBuildChat(req, res);
    return;
  }
  if (url.pathname === '/api/build/apply' && req.method === 'POST') {
    await applyStagedRun(req, res);
    return;
  }
  if (url.pathname === '/api/list-dirs' && req.method === 'GET') {
    handleListDirs(req, res);
    return;
  }
  if (url.pathname === '/health') {
    send(res, 200, 'ok\n');
    return;
  }
  if (url.pathname === '/error') {
    res.writeHead(302, { Location: '/' });
    res.end();
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

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    let owner = 'unknown';
    try {
      const out = execSync(`netstat -ano`, { encoding: 'utf8' });
      const line = out.split('\n').find(l => l.includes(`:${port} `) && l.includes('LISTENING'));
      if (line) owner = `PID ${line.trim().split(/\s+/).pop()}`;
    } catch {}
    console.error(`FATAL: Port ${port} already in use (${owner}). Kill it: Stop-Process -Id <pid> -Force`);
    process.exit(1);
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});

server.listen(port, '0.0.0.0', () => {
  console.log(`mav-console dashboard listening on http://0.0.0.0:${port}`);
  console.log(`Prometheus: ${prometheusUrl}`);
  console.log(`llama.cpp: ${llamaServerUrl}`);
});
