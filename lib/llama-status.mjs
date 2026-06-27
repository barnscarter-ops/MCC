// Workhorse model status for the dashboard's model panel.
// The default workhorse is Claude (Anthropic direct), so this checks Anthropic
// API connectivity and reports the configured model. Hosted API — no local
// token-throughput metrics, just online/offline + model name.
import { send } from './http.mjs';
import { anthropicApiKey, anthropicModel } from './config.mjs';

export async function getLlamaStatus(res) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3000);
  const endpoint = 'https://api.anthropic.com';
  let modelState = 'offline';
  let modelError = null;
  try {
    const response = await fetch(`${endpoint}/v1/models`, {
      signal: controller.signal,
      headers: { accept: 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' }
    });
    modelState = response.ok ? 'online' : 'error';
    modelError = response.ok ? null : `Anthropic status returned ${response.status}`;
  } catch (error) {
    modelState = 'offline';
    modelError = error.name === 'AbortError' ? 'Anthropic status timed out' : error.message;
  } finally {
    clearTimeout(timeout);
  }

  // Hosted API — local token-throughput metrics are not available.
  send(
    res,
    200,
    JSON.stringify({
      state: modelState,
      model: anthropicModel,
      contextTokens: null,
      parameterCount: null,
      endpoint,
      configuredModel: anthropicModel,
      evalSpeed: null,
      promptTokensTotal: null,
      outputTokensTotal: null,
      genSpeed: null,
      promptMetricsSource: 'anthropic',
      promptMetricsError: null,
      error: modelError
    }),
    'application/json; charset=utf-8'
  );
}
