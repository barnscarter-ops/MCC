// Upstream model + bridge clients: repo bridge, local llama, GPT-4o, Claude, Pi RPC,
// plus shared helpers (SSE token streaming, balanced-JSON extraction).
import { spawn } from 'node:child_process';
import {
  repoBridgeUrl, llamaServerUrl, localModel, openAiApiKey, openAiBaseUrl,
  anthropicApiKey, anthropicModel, piExecutable, piModel,
} from './config.mjs';
import { CLAUDE_ARCHITECT_SYSTEM } from './prompts.mjs';

export function textFromLlamaResponse(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  const chunks = payload?.output?.flatMap((item) => item?.content || []) || [];
  return chunks.map((chunk) => chunk?.text || '').filter(Boolean).join('\n').trim();
}

export async function callLocalModel(input, { maxOutputTokens = 1400 } = {}) {
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

export async function getRepoBridgeState() {
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

export async function callGpt4o(messages, signal, systemPrompt) {
  const sys = systemPrompt || CLAUDE_ARCHITECT_SYSTEM;
  const gptMessages = [
    { role: 'system', content: sys },
    ...messages
  ];
  const r = await fetch(`${openAiBaseUrl}/v1/chat/completions`, {
    method: 'POST',
    signal,
    headers: { 'content-type': 'application/json', 'Authorization': `Bearer ${openAiApiKey}` },
    body: JSON.stringify({ model: 'carter-gpt55', messages: gptMessages, temperature: 0.2, max_tokens: 2048 })
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

export async function callClaude(messages, signal, systemPrompt) {
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
