import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';

import {
  rootDir, distDir, port, deployStartedAt, prometheusUrl, ragUrl, llamaServerUrl,
  types, ALLOWED_ORIGINS,
} from './lib/config.mjs';
import { send, sendJson, readJsonBody } from './lib/http.mjs';
import { seoTaskLog } from './lib/state.mjs';
import { getMemoryIndex } from './lib/memory.mjs';
import { callRepoBridge } from './lib/models.mjs';
import { getLlamaStatus } from './lib/llama-status.mjs';
import { handleExtractFile } from './lib/extract.mjs';
import { getSeoWorkflowStatus, proxySeoActions } from './routes/seo.mjs';
import {
  getOrchestratorStatus, createOrchestratorPlan, createLocalWorkerBrief,
  createTaskRun, updateTaskRun,
} from './routes/orchestrator.mjs';
import { handleChat, handleBuildChat } from './lib/chat.mjs';
import { applyStagedRun, handleListDirs } from './routes/build.mjs';

// __dirname kept for code not yet modularized; equals config.rootDir.
const __dirname = rootDir;

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
  if (url.pathname === '/api/workflows/seo/tasks/log') {
    sendJson(res, 200, { tasks: [...seoTaskLog].reverse().slice(0, 50) });
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
  if (url.pathname === '/api/extract-file' && req.method === 'POST') {
    await handleExtractFile(req, res);
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
