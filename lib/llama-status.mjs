// llama.cpp runtime status + token-throughput metrics for the dashboard's LOCAL MODEL panel.
// Tries the Prometheus /metrics endpoint first, then falls back to /api/ps. Pure leaf:
// reads from llama-server over HTTP and writes the JSON response — no shared state.
import { send } from './http.mjs';
import { llamaServerUrl } from './config.mjs';

export async function getLlamaStatus(res) {
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
