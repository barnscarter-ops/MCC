// Local model status for the dashboard's "LOCAL AI CORE" / LLAMA METRICS panel.
// Probes the local llama.cpp server (LOCAL_MODEL_URL, OpenAI-compatible) and
// reports the served model, its context/parameter size, and live token
// throughput from llama.cpp's Prometheus /metrics endpoint.
//
// History: during the LiteLLM retirement this file briefly reported the
// Anthropic workhorse (Haiku), which made the "LOCAL MODEL" panel show a cloud
// model. It now reports the actual local Qwen again.
import { send } from './http.mjs';
import { localModelUrl, localModel } from './config.mjs';

// llama.cpp serves OpenAI routes under …/v1; /metrics sits at the server root.
function baseUrl() {
  return localModelUrl.replace(/\/v1\/?$/, '');
}

// Parse the four metrics the panel shows out of llama.cpp's Prometheus text.
// Exported for the self-check (scripts/check_llama_status.mjs).
export function parseLlamaMetrics(text) {
  const read = (name) => {
    // Match a metric line "name <value>", skipping "# HELP/# TYPE" comment lines.
    const m = text.match(new RegExp('^' + name.replace(/[:]/g, '\\$&') + '\\s+([0-9.eE+-]+)', 'm'));
    if (!m) return null;
    const v = Number(m[1]);
    return Number.isFinite(v) ? v : null;
  };
  return {
    evalSpeed: read('llamacpp:prompt_tokens_seconds'),       // prompt eval throughput
    genSpeed: read('llamacpp:predicted_tokens_seconds'),     // generation throughput
    promptTokensTotal: read('llamacpp:prompt_tokens_total'),
    outputTokensTotal: read('llamacpp:tokens_predicted_total'),
  };
}

async function fetchJson(url, signal) {
  const r = await fetch(url, { signal, headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url} returned ${r.status}`);
  return r.json();
}

export async function getLlamaStatus(res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const endpoint = baseUrl();

  let state = 'offline';
  let error = null;
  let model = localModel;
  let contextTokens = null;
  let parameterCount = null;
  let metrics = { evalSpeed: null, genSpeed: null, promptTokensTotal: null, outputTokensTotal: null };
  let promptMetricsSource = 'unavailable';
  let promptMetricsError = null;

  try {
    // 1) Model identity + size from the OpenAI-compatible models route.
    const models = await fetchJson(`${endpoint}/v1/models`, controller.signal);
    const entry = models?.data?.[0] || null;
    state = 'online';
    if (entry) {
      model = entry.id || localModel;
      // llama.cpp exposes training context + parameter count under meta.
      contextTokens = entry.meta?.n_ctx_train ?? entry.meta?.n_ctx ?? null;
      parameterCount = entry.meta?.n_params ?? null;
    }

    // 2) Live throughput from the Prometheus metrics endpoint (best-effort).
    try {
      const m = await fetch(`${endpoint}/metrics`, { signal: controller.signal, headers: { accept: 'text/plain' } });
      if (m.ok) {
        metrics = parseLlamaMetrics(await m.text());
        promptMetricsSource = 'llama';
      } else {
        promptMetricsError = `metrics returned ${m.status}`;
      }
    } catch (e) {
      promptMetricsError = e.name === 'AbortError' ? 'metrics timed out' : e.message;
    }
  } catch (e) {
    state = 'offline';
    error = e.name === 'AbortError' ? 'local model timed out' : e.message;
  } finally {
    clearTimeout(timeout);
  }

  send(
    res,
    200,
    JSON.stringify({
      state,
      model,
      contextTokens,
      parameterCount,
      endpoint,
      configuredModel: localModel,
      evalSpeed: metrics.evalSpeed,
      genSpeed: metrics.genSpeed,
      promptTokensTotal: metrics.promptTokensTotal,
      outputTokensTotal: metrics.outputTokensTotal,
      promptMetricsSource,
      promptMetricsError,
      error,
    }),
    'application/json; charset=utf-8'
  );
}
