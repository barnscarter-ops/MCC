// The assistant brain: the /api/chat and /api/build-chat engines. Claude directs,
// Pi/Qwen execute, NIM reviews. Modes: ask (RAG→Claude→Qwen fallback), build, ops,
// claude-code (Superpowers CLI), estimate (HCP pipeline), vision (image attachments).
// recordChatFailure + the Pi/Qwen delegation helpers stay here because the whole
// cluster is mutually coupled — splitting it further only multiplies cross-imports.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import {
  ragUrl, nimApiKey, nimModel, nimQcModel,
  anthropicApiKey, anthropicModel, geminiApiKey, geminiModel,
  GEMINI_MODES, workspacePath, hcpDir,
  openRouterUrl, openRouterApiKey, openRouterModel, openRouterExecutorModel,
} from './config.mjs';
import { sseWrite, buildChatSseWrite, sendJson, readJsonBody } from './http.mjs';
import { addLedgerRun } from './state.mjs';
import { CLAUDE_ASK_SYSTEM, CLAUDE_ESTIMATE_FALLBACK_SYSTEM, CLAUDE_OPS_SYSTEM, ESTIMATE_EXTRACT_SYSTEM, ESTIMATE_EDIT_SYSTEM } from './prompts.mjs';
import { callClaude, callPiRpc, openRouterChat } from './models.mjs';
import { resolveSafePath, loadSkills, workspaceTree, runExecTool, runOpsExecTool, persistStagedRun } from './exec.mjs';
import { triggerSelfImprove } from './self-improve.mjs';
import { buildDashboardContext } from '../routes/orchestrator.mjs';

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
        result = await delegateWriteToExecutor(task, staged, controller);
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

    // Post-build debrief: concise summary of what was built and how to test it
    if (!controller.signal.aborted) {
      try {
        const stagedPaths = staged.files.filter(f => f.content !== '__DELETE__').map(f => f.path).join('\n');
        const debrief = await callClaude(
          [{ role: 'user', content: `Build task: "${prompt.slice(0, 300)}"\n\nFiles staged:\n${stagedPaths}\n\nWrite a 1-2 sentence summary: what was created/changed (exact filenames) and one-liner on how to run or test it. No preamble, no headers.` }],
          controller.signal,
          'You are a senior developer. Be specific and concise.'
        );
        const debriefText = debrief.answer || debrief.summary || '';
        if (debriefText) sseWrite(res, `\n**Summary:** ${debriefText}\n`);
      } catch {}
    }
  }

  res.write('data: [DONE]\n\n');
  res.end();
}

// Vision query — Claude streaming with image attachments (blueprints, site photos, scanned PDFs)
async function handleVisionQuery(res, controller, imageAttachments, textPrompt, histMsgs, system) {
  if (!anthropicApiKey) {
    sseWrite(res, '[Vision requires ANTHROPIC_API_KEY — not configured]');
    return;
  }
  const content = [
    ...imageAttachments.map(img => ({
      type: 'image',
      source: { type: 'base64', media_type: img.mimeType || 'image/jpeg', data: img.data }
    })),
    { type: 'text', text: textPrompt || 'Analyze these images.' }
  ];
  const messages = [...histMsgs, { role: 'user', content }];
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: anthropicModel, system, messages, max_tokens: 2048, stream: true }),
      // Note: vision queries still use direct Anthropic API for image support
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      sseWrite(res, `[Vision API error ${r.status}: ${txt.slice(0, 100)}]`);
      return;
    }
    const reader = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        try {
          const tok = JSON.parse(line.slice(6).trim());
          // Anthropic streaming: {type:"content_block_delta", delta:{type:"text_delta", text:"..."}}
          if (tok.type === 'content_block_delta' && tok.delta?.text) sseWrite(res, tok.delta.text);
        } catch {}
      }
    }
  } catch (err) {
    if (err.name !== 'AbortError') sseWrite(res, `[Vision error: ${err.message}]`);
  }
}

// ── Pi RPC (BUILD executor) ────────────────────────────────────────────────

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

  if (openRouterApiKey) {
    try {
      const text = await openRouterChat(
        [{ role: 'user', content: reviewPrompt }],
        { model: openRouterModel, maxTokens: 150, temperature: 0.1, signal: AbortSignal.timeout(20_000) },
      );
      if (text) return text;
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

// ── Code-write delegate (OPS only) — OpenRouter GLM executor ───────────────

async function delegateWriteToExecutor(task, staged, controller) {
  // Executor receives the current file + Claude's precise instruction and produces the full updated file
  const currentContent = staged.readPaths.has(task.path)
    ? (staged.files.find(f => f.path === task.path)?.content ?? null)
    : null;

  const readStaged = { id: staged.id, prompt: staged.prompt, files: staged.files, readPaths: staged.readPaths };
  const fileContent = currentContent ?? await runExecTool('read_file', { path: task.path }, readStaged);

  const editorMessages = [
    {
      role: 'system',
      content: `You are a code editor. You receive a file and a precise instruction. You output ONLY the complete updated file — no explanation, no markdown fences, no commentary.`
    },
    {
      role: 'user',
      content: `File: ${task.path}\n\nCurrent content:\n${fileContent}\n\nInstruction: ${task.instruction}\n\nOutput the complete updated file:`
    }
  ];

  const newContent = await openRouterChat(editorMessages, {
    model: openRouterExecutorModel,
    signal: controller.signal,
    temperature: 0.1,
    maxTokens: 4000,
  });
  // Strip any accidental markdown fences the model might add
  const stripped = newContent.replace(/^```[\w]*\n?/, '').replace(/\n?```$/, '');
  return await runExecTool('write_file', { path: task.path, content: stripped }, staged);
}

export async function handleBuildChat(req, res) {
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

async function handleClaudeCodeSession(res, controller, prompt, histMsgs, attachBlock, folderPaths) {
  const workDir = folderPaths[0] || workspacePath;

  const histCtx = histMsgs.slice(-4)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content).slice(0, 500)}`)
    .join('\n');
  const fullPrompt = [
    histCtx ? `Previous context:\n${histCtx}` : '',
    attachBlock ? `\nAttached context:${attachBlock}` : '',
    `\nTask: ${prompt}`
  ].filter(Boolean).join('\n').trim();

  sseWrite(res, '⚡ **SUPERPOWERS — CLAUDE CODE**\n\n');

  const proc = spawn('claude', [
    '--print',
    '--output-format', 'stream-json',
    '--dangerously-skip-permissions',
    fullPrompt
  ], { cwd: workDir, env: { ...process.env } });

  controller.signal.addEventListener('abort', () => { try { proc.kill(); } catch {} });

  let buf = '';
  let emittedText = '';

  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const evt = JSON.parse(trimmed);
        if (evt.type === 'assistant' && Array.isArray(evt.message?.content)) {
          for (const block of evt.message.content) {
            if (block.type === 'text' && block.text) {
              sseWrite(res, block.text);
              emittedText += block.text;
            }
          }
        } else if (evt.type === 'tool_use') {
          const toolName = evt.name || '';
          const inp = evt.input || {};
          const detail = inp.file_path || inp.command || inp.path || inp.query || '';
          sseWrite(res, `\n\`→ ${toolName}(${String(detail).slice(0, 80)})\`\n`);
        } else if (evt.type === 'result') {
          const cost = evt.total_cost_usd != null ? ` · $${Number(evt.total_cost_usd).toFixed(4)}` : '';
          if (evt.result && !emittedText.includes(evt.result.slice(0, 50))) {
            sseWrite(res, `\n\n${evt.result}`);
          }
          if (cost) sseWrite(res, `\n\n*${evt.subtype || 'done'}${cost}*`);
        }
      } catch {}
    }
  });

  proc.stderr.on('data', (chunk) => {
    const msg = chunk.toString('utf8').trim();
    if (msg && !msg.includes('ExperimentalWarning') && !msg.includes('DeprecationWarning')) {
      sseWrite(res, `\n[stderr: ${msg.slice(0, 200)}]\n`);
    }
  });

  await new Promise((resolve) => {
    proc.on('close', resolve);
    proc.on('error', (err) => {
      if (err.code === 'ENOENT') {
        sseWrite(res, '\n[Claude Code CLI not found — install with: npm install -g @anthropic-ai/claude-code]\n');
      } else {
        sseWrite(res, `\n[Error spawning claude: ${err.message}]\n`);
      }
      resolve();
    });
  });

  res.write('data: [DONE]\n\n');
  res.end();
}

const ESTIMATE_TRIGGERS = ['build it', 'create the estimate', 'make the estimate', 'go ahead', 'fire it', 'push it', 'send it', 'do it', "let's do it", 'sounds good', 'looks good'];

function buildEstimateSummary(extracted) {
  const BADGE = { matched: '✅', adjusted: '🔄', new: '⭐' };
  const items = extracted.items || [];
  const newItems = extracted.newItems || [];
  const customer = extracted.customer || {};
  let md = '**Estimate Summary**\n\n';
  if (customer.name) {
    md += `**Customer:** ${customer.name}`;
    if (customer.email) md += ` · ${customer.email}`;
    if (customer.phone) md += ` · ${customer.phone}`;
    md += '\n';
  }
  if (extracted.address) {
    md += `**Job site:** ${extracted.address}\n`;
  } else {
    md += `*Address: using customer default — verify in HCP after*\n`;
  }
  md += '\n';
  const allItems = [...items, ...newItems.map(ni => ({ ...ni, type: 'new' }))];
  if (!allItems.length) {
    md += '*No agreed-upon items found — describe the job and pricing then try again.*\n';
  } else {
    md += '| | Item | Qty | Unit Price |\n|---|---|---|---|\n';
    for (const item of allItems) {
      const badge = BADGE[item.type] || '⭐';
      const price = item.unitPrice > 0 ? `$${Number(item.unitPrice).toFixed(2)}` : '$0 *(set in HCP)*';
      const saveNote = item.saveToBook === false ? ' *(this estimate only)*' : item.saveToBook === true ? ' *(saving to book)*' : '';
      md += `| ${badge} | ${item.name}${saveNote} | ${item.quantity} | ${price} |\n`;
    }
    md += '\n✅ Exact match · 🔄 Adjusted · ⭐ New/custom\n';
  }
  md += '\n*Reply to make changes, or click **BUILD IT** to push to HCP.*';
  return md;
}

async function spawnEstimatePipeline(payload, res, controller) {
  await new Promise(resolve => {
    const proc = spawn('npx', ['tsx', 'src/automations/estimates/from-chat.ts'], {
      cwd: hcpDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });

    proc.stdin.write(JSON.stringify(payload));
    proc.stdin.end();

    let stdout = '';
    proc.stdout.on('data', d => { stdout += d; });
    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        const m = line.match(/\[progress\] (.+)/);
        if (m) sseWrite(res, m[1].trim() + '\n');
      }
    });

    const timer = setTimeout(() => { proc.kill(); sseWrite(res, '\n❌ Pipeline timed out after 3 minutes.'); resolve(); }, 180_000);

    proc.on('close', () => {
      clearTimeout(timer);
      try {
        const result = JSON.parse(stdout);
        if (result.success) {
          sseWrite(res, `\n✅ Estimate created!\n\n[Open in HCP](${result.estimateUrl})`);
          if (Array.isArray(result.unmatched) && result.unmatched.length) {
            sseWrite(res, `\n\n⚠️ ${result.unmatched.length} item(s) added at $0 — set price in HCP:\n${result.unmatched.map(u => `  • ${u}`).join('\n')}`);
          }
        } else {
          sseWrite(res, `\n❌ Pipeline failed: ${result.error}`);
        }
      } catch { sseWrite(res, '\n❌ Pipeline returned unexpected output.'); }
      resolve();
    });

    proc.on('error', err => { clearTimeout(timer); sseWrite(res, `\n❌ Failed to start pipeline: ${err.message}`); resolve(); });
    controller.signal.addEventListener('abort', () => { clearTimeout(timer); proc.kill(); resolve(); }, { once: true });
  });
}

async function spawnMaverickAgent(payload, res, controller) {
  await new Promise(resolve => {
    const proc = spawn('npx', ['tsx', 'src/agent/run.ts'], {
      cwd: hcpDir,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
      shell: true,
      windowsHide: true,
    });

    // stream: true → agent writes "data: <chunk>\n" lines; pipe each chunk through as SSE
    proc.stdin.write(JSON.stringify({ ...payload, stream: true }));
    proc.stdin.end();

    let buf = '';
    proc.stdout.on('data', d => {
      buf += d.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          sseWrite(res, line.slice(6));
        } else if (line.startsWith('[DONE]') || line.startsWith('[ERROR]')) {
          // terminal markers — don't forward to client
        }
      }
    });

    proc.stderr.on('data', d => {
      for (const line of d.toString().split('\n')) {
        const m = line.match(/\[progress\] (.+)/);
        if (m) sseWrite(res, `\n*${m[1].trim()}*\n`);
      }
    });

    const timer = setTimeout(() => { proc.kill(); sseWrite(res, '\n❌ Agent timed out after 3 minutes.'); resolve(); }, 180_000);

    proc.on('close', () => { clearTimeout(timer); resolve(); });
    proc.on('error', err => { clearTimeout(timer); sseWrite(res, `❌ Failed to start agent: ${err.message}`); resolve(); });
    controller.signal.addEventListener('abort', () => { clearTimeout(timer); proc.kill(); resolve(); }, { once: true });
  });
}

async function handleEstimateFromAsk(histMsgs, prompt, res, controller) {
  sseWrite(res, '📋 Reading our conversation to build the estimate...\n');

  let extracted = null;
  try {
    const extractRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: 1200,
        system: ESTIMATE_EXTRACT_SYSTEM,
        messages: [
          ...histMsgs.slice(-16),
          { role: 'user', content: prompt }
        ].map(m => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: typeof m.content === 'string' ? m.content.slice(0, 3000) : JSON.stringify(m.content).slice(0, 3000),
        })),
      }),
    });
    if (extractRes.ok) {
      const data = await extractRes.json();
      const text = (data.content?.[0]?.text || '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) extracted = JSON.parse(match[0]);
    }
  } catch (e) {
    if (e.name === 'AbortError') { if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); } return; }
  }

  if (!extracted?.items?.length) {
    sseWrite(res, "I couldn't find agreed-upon items in our conversation yet. Can you confirm the scope and pricing so I can build the estimate?");
    if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
    return;
  }

  const readyPayload = { items: extracted.items, customer: extracted.customer || {} };
  sseWrite(res, buildEstimateSummary(extracted) + `\n\n[ESTIMATE_READY]${JSON.stringify(readyPayload)}[/ESTIMATE_READY]`);
  if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
}

async function handleEstimateEdit(pendingItems, pendingCustomer, editRequest, res, controller) {
  let updated = null;
  try {
    const editRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      signal: controller.signal,
      headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: anthropicModel,
        max_tokens: 800,
        system: ESTIMATE_EDIT_SYSTEM,
        messages: [{
          role: 'user',
          content: `Current estimate:\n${JSON.stringify({ items: pendingItems, customer: pendingCustomer }, null, 2)}\n\nUser request: ${editRequest}`,
        }],
      }),
    });
    if (editRes.ok) {
      const data = await editRes.json();
      const text = (data.content?.[0]?.text || '').trim();
      const match = text.match(/\{[\s\S]*\}/);
      if (match) updated = JSON.parse(match[0]);
    }
  } catch (e) {
    if (e.name === 'AbortError') { if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); } return; }
  }

  if (!updated?.items?.length) {
    sseWrite(res, "I couldn't parse that change — could you describe it differently?");
    if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
    return;
  }

  const readyPayload = { items: updated.items, customer: updated.customer || pendingCustomer || {} };
  sseWrite(res, 'Got it — here\'s the updated estimate:\n\n' + buildEstimateSummary({ ...readyPayload, address: null }) + `\n\n[ESTIMATE_READY]${JSON.stringify(readyPayload)}[/ESTIMATE_READY]`);
  if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
}

export async function handleChat(req, res) {
  try {
    const { prompt, mode = 'ask', history = [], attachments = [], lineItems, pendingItems, pendingCustomer, newPricebookItems, techIds, depositPercent } = await readJsonBody(req);
    if (!prompt?.trim() && mode !== 'estimate-ready') {
      sendJson(res, 400, { error: 'Prompt is required.' });
      return;
    }

    // Folder attachments — resolve paths server-side, no content upload needed
    const folderPaths = (Array.isArray(attachments) ? attachments : [])
      .filter((a) => a?.type === 'folder' && typeof a.path === 'string')
      .map((a) => resolveSafePath(a.path))
      .filter(Boolean)
      .slice(0, 5);

    // Image attachments — routed to Claude vision, bypassing RAG
    const imageAttachments = (Array.isArray(attachments) ? attachments : [])
      .filter(a => a?.type === 'image' && typeof a.data === 'string' && a.data.length > 0)
      .slice(0, 4);

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
      ask: CLAUDE_ASK_SYSTEM + ctxBlock,
      ops: CLAUDE_OPS_SYSTEM + ctxBlock,
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

    // ESTIMATE-READY → pre-structured line items (from ASK MAVERICK or MAVERICK AGENT), bypass extraction
    if (mode === 'estimate-ready') {
      sseWrite(res, '⚡ Creating estimate in HCP...\n\n');
      await spawnEstimatePipeline({
        lineItems,
        newPricebookItems:  newPricebookItems  || undefined,
        customerName:       pendingCustomer?.name  || undefined,
        customerEmail:      pendingCustomer?.email || undefined,
        customerPhone:      pendingCustomer?.phone || undefined,
        techIds:            Array.isArray(techIds) && techIds.length ? techIds : undefined,
        depositPercent:     depositPercent ?? undefined,
      }, res, controller);
      if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
      return;
    }

    // AGENT → Maverick agent (Mastra, read tools, Phase 2+ for write workflows)
    if (mode === 'agent') {
      await spawnMaverickAgent({ prompt: prompt.trim(), history: histMsgs, channel: 'text' }, res, controller);
      if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
      return;
    }

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

    // SUPERPOWERS → full Claude Code CLI session, direct file access
    if (mode === 'claude-code') {
      await handleClaudeCodeSession(res, controller, prompt.trim(), histMsgs, attachBlock, folderPaths);
      return;
    }

    // ASK → field tech assistant: NEC lookups, voltage drop, troubleshooting, code questions
    if (mode === 'ask') {
      if (imageAttachments.length > 0) {
        await handleVisionQuery(res, controller, imageAttachments,
          prompt.trim() + (attachBlock ? '\n\n' + attachBlock : ''),
          histMsgs, CLAUDE_ESTIMATE_FALLBACK_SYSTEM);
        if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
        return;
      }

      // RAG /ask — queries all collections (NEC, Oncor, customers, pricebook)
      let ragOk = false;
      const ragCtrl = new AbortController();
      const ragTimeout = setTimeout(() => ragCtrl.abort(), 30_000);
      try {
        const ragResp = await fetch(new URL('/ask', ragUrl), {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          signal: ragCtrl.signal,
          body: JSON.stringify({ message: prompt.trim() + (attachBlock ? '\n\n' + attachBlock : ''), history: histMsgs, top_k: 15 })
        });
        clearTimeout(ragTimeout);
        if (ragResp.ok) {
          const ragData = await ragResp.json();
          const reply = (ragData.reply || '').trim();
          if (reply) { sseWrite(res, reply); ragOk = true; }
        }
      } catch { clearTimeout(ragTimeout); /* RAG offline or timed out — fall through */ }

      if (!ragOk) {
        // Fallback: Claude direct → OpenRouter (callClaude handles the cascade internally).
        const msgs = [
          ...histMsgs,
          { role: 'user', content: prompt.trim() + (attachBlock ? '\n\n' + attachBlock : '') }
        ];
        try {
          const directive = await callClaude(msgs, controller.signal, CLAUDE_ESTIMATE_FALLBACK_SYSTEM);
          const reply = directive.answer || directive.summary || (typeof directive === 'string' ? directive : '');
          if (reply) sseWrite(res, reply);
          else { sseWrite(res, '[All backends offline — please try again]'); recordChatFailure('ask', prompt, 'RAG + Claude/OpenRouter offline'); }
        } catch (cErr) {
          if (cErr.name === 'AbortError') { if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); } return; }
          sseWrite(res, `[Error: ${cErr.message}]`);
          recordChatFailure('ask', prompt, cErr);
        }
      }

      if (res.writable) { res.write('data: [DONE]\n\n'); res.end(); }
      return;
    }

    // REVIEW → Gemini Flash (if key set), otherwise OpenRouter
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
        upstream = await fetch(`${openRouterUrl}/chat/completions`, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', accept: 'text/event-stream', 'Authorization': `Bearer ${openRouterApiKey}` },
          body: JSON.stringify({ model: openRouterModel, messages, stream: true, temperature: 0.7, max_tokens: 1400 })
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
