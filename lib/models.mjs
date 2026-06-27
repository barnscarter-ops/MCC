// Upstream model + SEO app clients: SEO Agents App, local llama, GPT-4o, Claude, Pi RPC,
// plus shared helpers (SSE token streaming, balanced-JSON extraction).
import { spawn } from 'node:child_process';
import {
  seoAppUrl, openAiApiKey, openAiBaseUrl, openAiModel,
  openRouterUrl, openRouterApiKey, openRouterModel,
  localModelUrl, localModel,
  anthropicApiKey, anthropicModel, piExecutable, piModel,
} from './config.mjs';
import { CLAUDE_ARCHITECT_SYSTEM } from './prompts.mjs';

// ── Provider primitives (all return plain text) ────────────────────────────
// Claude — direct Anthropic API (default workhorse + planner + chat).
export async function anthropicChat(messages, { system, model = anthropicModel, signal, maxTokens = 2048, temperature = 0.2 } = {}) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, system, messages, max_tokens: maxTokens, temperature }),
  });
  if (!r.ok) throw new Error(`Anthropic ${model} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const payload = await r.json();
  return payload.content?.map((c) => c?.text || '').join('').trim() || '';
}

// OpenRouter — "anything else" (executor, review, fallbacks). OpenAI-compatible.
export async function openRouterChat(messages, { system, model = openRouterModel, signal, maxTokens = 2048, temperature = 0.2 } = {}) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await fetch(`${openRouterUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${openRouterApiKey}` },
    body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens, temperature }),
  });
  if (!r.ok) throw new Error(`OpenRouter ${model} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const payload = await r.json();
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

// Local llama.cpp (custom Qwen) — OpenAI-compatible, no auth. Code executor (build/ops).
export async function localChat(messages, { system, model = localModel, signal, maxTokens = 2048, temperature = 0.2 } = {}) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await fetch(`${localModelUrl}/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens, temperature }),
  });
  if (!r.ok) throw new Error(`Local ${model} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const payload = await r.json();
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

// OpenAI / Codex — direct OpenAI API.
export async function openAiChat(messages, { system, model = openAiModel, signal, maxTokens = 2048, temperature = 0.2 } = {}) {
  const msgs = system ? [{ role: 'system', content: system }, ...messages] : messages;
  const r = await fetch(`${openAiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${openAiApiKey}` },
    body: JSON.stringify({ model, messages: msgs, max_tokens: maxTokens, temperature }),
  });
  if (!r.ok) throw new Error(`OpenAI ${model} ${r.status}: ${(await r.text().catch(() => '')).slice(0, 200)}`);
  const payload = await r.json();
  return payload.choices?.[0]?.message?.content?.trim() || '';
}

// Workhorse text completion (orchestrator plan/brief/task). Claude direct, OpenRouter fallback.
export async function callLocalModel(input, { maxOutputTokens = 1400 } = {}) {
  const messages = Array.isArray(input) ? input : [{ role: 'user', content: String(input) }];
  try {
    return await anthropicChat(messages, { maxTokens: maxOutputTokens, temperature: 0.15 });
  } catch (err) {
    console.warn(`[workhorse] Anthropic failed — OpenRouter fallback: ${err.message}`);
    return await openRouterChat(messages, { maxTokens: maxOutputTokens, temperature: 0.15 });
  }
}

export async function callSeoApp(pathname, { method = 'GET', body = null, timeoutMs = 180_000 } = {}) {
  if (!seoAppUrl) {
    throw new Error('SEO App is not configured.');
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(new URL(pathname, seoAppUrl), {
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
      throw new Error(payload?.error || `SEO App failed: ${response.status}`);
    }
    return { ...payload, source: 'seo-app' };
  } catch (error) {
    throw new Error(error.name === 'AbortError' ? 'SEO App action timed out' : error.message);
  } finally {
    clearTimeout(timeout);
  }
}

export async function getSeoAppState() {
  if (!seoAppUrl) {
    return { endpoint: null, state: 'not-configured' };
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(new URL('/health', seoAppUrl), {
      signal: controller.signal,
      headers: { accept: 'application/json' }
    });
    const payload = await response.json();
    return {
      endpoint: seoAppUrl,
      state: response.ok && payload?.state === 'online' ? 'seo-app-online' : 'seo-app-error',
      detail: payload?.defaultRepo || null
    };
  } catch (error) {
    return {
      endpoint: seoAppUrl,
      state: 'seo-app-offline',
      detail: error.name === 'AbortError' ? 'health timed out' : error.message
    };
  } finally {
    clearTimeout(timeout);
  }
}

export async function streamUpstream(upstream, onToken) {
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

// Extracts the first balanced JSON object from a string.
// Handles nested objects, curly braces inside strings, and escape sequences.
// More reliable than a greedy regex when the model includes extra text or multiple objects.
export function extractJsonObject(text) {
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

// JSON planner via OpenAI / Codex direct.
export async function callGpt4o(messages, signal, systemPrompt, modelOverride) {
  const sys = systemPrompt || CLAUDE_ARCHITECT_SYSTEM;
  const text = await openAiChat(messages, { system: sys, model: modelOverride || openAiModel, signal });
  const json = extractJsonObject(text);
  if (!json) {
    console.warn('[planner openai] non-JSON response, wrapping as done+answer:', text.slice(0, 120));
    return { done: true, answer: text };
  }
  try {
    return JSON.parse(json);
  } catch (err) {
    console.warn('[planner openai] extracted JSON failed to parse, wrapping full text:', err.message);
    return { done: true, answer: text };
  }
}

// JSON planner — Claude direct (default), OpenRouter fallback.
export async function callClaude(messages, signal, systemPrompt, modelOverride) {
  const sys = systemPrompt || CLAUDE_ARCHITECT_SYSTEM;
  const model = modelOverride || anthropicModel;
  let text;
  try {
    text = await anthropicChat(messages, { system: sys, model, signal });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    console.warn(`[planner] Anthropic ${model} failed — OpenRouter fallback: ${err.message}`);
    try {
      text = await openRouterChat(messages, { system: sys, model: openRouterModel, signal });
    } catch (err2) {
      if (err2.name === 'AbortError') throw err2;
      console.warn(`[planner] OpenRouter fallback failed: ${err2.message}`);
      return { done: true, answer: `[Planner offline: ${err.message}]` };
    }
  }
  const json = extractJsonObject(text);
  if (!json) {
    console.warn(`[planner ${model}] non-JSON response, wrapping as done+answer:`, text.slice(0, 120));
    return { done: true, answer: text };
  }
  try {
    return JSON.parse(json);
  } catch (e) {
    console.warn(`[planner ${model}] extracted JSON failed to parse, wrapping full text:`, e.message);
    return { done: true, answer: text };
  }
}

export function callPiRpc(prompt, signal) {
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
