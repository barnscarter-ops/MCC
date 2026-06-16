import { spawn } from 'node:child_process';
import { piBin, piProvider, piModel, piWorkdir } from '../config.mjs';

// Run a one-shot Pi coding agent task in RPC mode, streaming text deltas to an SSE response.
// Pi RPC protocol: JSONL over stdin/stdout. Do NOT use node:readline — it splits on
// Unicode separators which breaks the protocol. Manual \n buffering is used instead.
export async function runPiChat(res, abortSignal, prompt, { history = [], sessionDir = null } = {}) {
  const args = ['--mode', 'rpc'];
  if (piProvider) args.push('--provider', piProvider);
  if (piModel) args.push('--model', piModel);
  if (sessionDir) {
    args.push('--session-dir', sessionDir);
  } else {
    args.push('--no-session');
  }

  let child;
  try {
    child = spawn(piBin, args, {
      cwd: piWorkdir,
      stdio: ['pipe', 'pipe', 'pipe']
    });
  } catch (spawnErr) {
    res.write(`data: ${JSON.stringify({ type: 'error', text: `Pi agent unavailable: ${spawnErr.message}` })}\n\n`);
    res.write('data: [DONE]\n\n');
    res.end();
    return;
  }

  // Forward abort signal to the Pi process
  const onAbort = () => { try { child.kill('SIGTERM'); } catch {} };
  abortSignal?.addEventListener('abort', onAbort, { once: true });

  // Buffer stderr for error reporting
  let stderrBuf = '';
  child.stderr.on('data', (chunk) => {
    stderrBuf += chunk.toString('utf8');
    if (stderrBuf.length > 2000) stderrBuf = stderrBuf.slice(-2000);
  });

  // Collect stdout JSONL events and stream text deltas to SSE
  let stdoutBuf = '';
  let agentStarted = false;

  child.stdout.on('data', (chunk) => {
    stdoutBuf += chunk.toString('utf8');
    const lines = stdoutBuf.split('\n');
    stdoutBuf = lines.pop(); // Keep incomplete last line in buffer
    for (const line of lines) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      handlePiEvent(res, event);
    }
  });

  // Send the prompt once the process is ready by listening for the first agent_start
  // Pi accepts commands immediately on stdin — send right away
  const promptCmd = JSON.stringify({ command: 'prompt', id: 'p1', text: buildPromptText(prompt, history) });
  child.stdin.write(promptCmd + '\n');

  await new Promise((resolve) => {
    child.on('close', (code) => {
      abortSignal?.removeEventListener('abort', onAbort);
      // Flush any remaining buffered output
      if (stdoutBuf.trim()) {
        try {
          const event = JSON.parse(stdoutBuf.trim());
          handlePiEvent(res, event);
        } catch {}
      }
      if (code !== 0 && code !== null && !abortSignal?.aborted) {
        const errMsg = stderrBuf.trim() || `Pi exited with code ${code}`;
        res.write(`data: ${JSON.stringify({ type: 'error', text: errMsg })}\n\n`);
      }
      resolve();
    });
    child.on('error', (err) => {
      abortSignal?.removeEventListener('abort', onAbort);
      res.write(`data: ${JSON.stringify({ type: 'error', text: err.message })}\n\n`);
      resolve();
    });
  });

  if (res.writable) {
    res.write('data: [DONE]\n\n');
    res.end();
  }
}

function handlePiEvent(res, event) {
  if (!res.writable) return;

  // message_update carries streaming text/thinking/tool deltas
  if (event.type === 'message_update') {
    const delta = event.assistantMessageEvent;
    if (!delta) return;

    if (delta.type === 'text_delta' && typeof delta.text === 'string') {
      // Forward as SSE data chunk compatible with the existing chat stream format
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: delta.text } }] })}\n\n`);
      return;
    }
    // thinking_delta — forward as a separate event type for the UI to handle
    if (delta.type === 'thinking_delta' && typeof delta.thinking === 'string') {
      res.write(`data: ${JSON.stringify({ type: 'thinking', text: delta.thinking })}\n\n`);
      return;
    }
    return;
  }

  // tool_execution_update — surface tool name and partial result so the UI can show activity
  if (event.type === 'tool_execution_update') {
    const { toolName, partialResult } = event;
    if (toolName) {
      res.write(`data: ${JSON.stringify({ type: 'tool', tool: toolName, partial: partialResult ?? '' })}\n\n`);
    }
    return;
  }

  // agent_end — Pi finished; signal the UI
  if (event.type === 'agent_end') {
    res.write(`data: ${JSON.stringify({ type: 'agent_end' })}\n\n`);
    return;
  }

  // Error events
  if (event.type === 'extension_error' || event.error) {
    const msg = event.message || event.error || 'Unknown Pi error';
    res.write(`data: ${JSON.stringify({ type: 'error', text: msg })}\n\n`);
  }
}

function buildPromptText(prompt, history) {
  if (!history.length) return prompt;
  const ctx = history
    .slice(-10)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && m.content?.trim())
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.trim()}`)
    .join('\n');
  return `${ctx}\nUser: ${prompt}`;
}
