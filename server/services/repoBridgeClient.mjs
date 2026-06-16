import { repoBridgeUrl } from '../config.mjs';
import { sendJson, readJsonBody } from '../http.mjs';

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

export async function callRepoBridge(pathname, { method = 'GET', body = null, timeoutMs = 180_000 } = {}) {
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

export async function proxySeoActions(req, res, action) {
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
