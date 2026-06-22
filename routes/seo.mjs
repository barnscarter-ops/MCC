// SEO pipeline proxies — bridge the dashboard to the Windows repo-bridge's /seo endpoints.
// getSeoWorkflowStatus feeds the SEO panel; proxySeoActions forwards list/approve/run and
// records each approve/run in the task event log.
import { sendJson, readJsonBody } from '../lib/http.mjs';
import { repoBridgeUrl } from '../lib/config.mjs';
import { logSeoEvent } from '../lib/state.mjs';
import { callRepoBridge } from '../lib/models.mjs';

export async function getSeoWorkflowStatus() {
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

export async function proxySeoActions(req, res, action) {
  try {
    if (action === 'list') {
      sendJson(res, 200, await callRepoBridge('/seo/actions', { timeoutMs: 180_000 }));
      return;
    }
    const payload = await readJsonBody(req);
    const { actionId, label, type } = payload;
    if (action === 'approve') {
      let result;
      try {
        result = await callRepoBridge('/seo/actions/approve', { method: 'POST', body: payload, timeoutMs: 180_000 });
        logSeoEvent(actionId, label, type, 'approved', true, result.message || 'Approved');
        sendJson(res, 200, result);
      } catch (err) {
        logSeoEvent(actionId, label, type, 'approved', false, err.message);
        throw err;
      }
      return;
    }
    if (action === 'run') {
      let result;
      try {
        result = await callRepoBridge('/seo/actions/run', { method: 'POST', body: payload, timeoutMs: 600_000 });
        logSeoEvent(actionId, label, type, 'run', true, result.message || 'Triggered');
        sendJson(res, 200, result);
      } catch (err) {
        logSeoEvent(actionId, label, type, 'run', false, err.message);
        throw err;
      }
    }
  } catch (error) {
    sendJson(res, 500, { error: error.message, source: 'repo-bridge' });
  }
}
