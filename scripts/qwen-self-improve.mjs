#!/usr/bin/env node
/**
 * qwen-self-improve.mjs
 * Reads failed task runs from the ledger, asks Qwen to analyze each failure,
 * and saves structured lesson files to the memory directory.
 *
 * Usage: node scripts/qwen-self-improve.mjs
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync } from 'node:fs';
import path from 'node:path';

const LEDGER = path.join(
  'C:\\Workspace\\Active\\homelab-noc-dashboard\\homelab-noc-dashboard\\homelab-noc-dashboard\\.mav-console',
  'task-runs.json'
);
const MEMORY_DIR = process.env.MAV_MEMORY_PATH ||
  'C:\\Users\\carte\\.claude\\projects\\C--Workspace-Active-homelab-noc-dashboard-homelab-noc-dashboard-homelab-noc-dashboard\\memory';
const MEMORY_INDEX = path.join(MEMORY_DIR, 'MEMORY.md');
const LLAMA_URL = 'http://127.0.0.1:8080';
const MODEL = 'qwen3-14b';

function readLedger() {
  if (!existsSync(LEDGER)) return [];
  try { return JSON.parse(readFileSync(LEDGER, 'utf8')); } catch { return []; }
}

function slug(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 40);
}

async function askQwen(prompt) {
  const res = await fetch(`${LLAMA_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: MODEL,
      messages: [
        { role: 'system', content: 'You are an AI learning system. Analyze task failures and extract actionable lessons. Be concise and specific. Focus on root cause and prevention.' },
        { role: 'user', content: prompt }
      ],
      stream: false,
      temperature: 0.3,
      max_tokens: 600
    })
  });
  if (!res.ok) throw new Error(`Qwen returned ${res.status}`);
  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() || '';
}

function appendToIndex(lessonFile, title, hook) {
  if (!existsSync(MEMORY_INDEX)) return;
  let index = readFileSync(MEMORY_INDEX, 'utf8');
  const filename = path.basename(lessonFile);
  if (index.includes(filename)) return;
  const line = `- [${title}](${filename}) — ${hook}\n`;
  writeFileSync(MEMORY_INDEX, index.trimEnd() + '\n' + line);
}

async function main() {
  const runs = readLedger();
  const failed = runs.filter(r => r.status === 'failed' && (r.error || r.output));

  if (!failed.length) {
    console.log('No failed task runs found — nothing to learn from.');
    return;
  }

  console.log(`Found ${failed.length} failed task run(s). Analyzing with Qwen...`);
  mkdirSync(MEMORY_DIR, { recursive: true });

  // Skip runs already processed (check for existing lesson files)
  const existingFiles = existsSync(MEMORY_DIR) ? readdirSync(MEMORY_DIR) : [];
  const processedIds = new Set(
    existingFiles
      .filter(f => f.startsWith('lesson-'))
      .map(f => f.replace(/^lesson-/, '').replace(/\.md$/, '').split('-').slice(-1)[0])
  );

  let saved = 0;
  for (const run of failed.slice(0, 5)) {
    const runId = run.id || `${Date.now()}`;
    if (processedIds.has(runId)) {
      console.log(`Skipping already-processed run: ${run.taskTitle}`);
      continue;
    }

    console.log(`Analyzing: ${run.taskTitle} [${run.worker}]`);

    let analysis;
    try {
      analysis = await askQwen(
        `A task failed with the following details:\n\nTask: ${run.taskTitle}\nWorker: ${run.worker}\nError: ${run.error || 'No error captured'}\nOutput excerpt: ${String(run.output || '').slice(0, 600)}\n\nAnalyze what went wrong and provide:\n1. Root cause (1-2 sentences)\n2. What should be done differently next time\n3. Any patterns or conditions to watch for`
      );
    } catch (err) {
      console.error(`Qwen call failed for "${run.taskTitle}": ${err.message}`);
      continue;
    }

    if (!analysis) continue;

    const lessonSlug = `lesson-${slug(run.taskTitle || 'task')}-${runId}`;
    const lessonFile = path.join(MEMORY_DIR, `${lessonSlug}.md`);

    const memory = `---
name: ${lessonSlug}
description: Lesson from failed ${run.worker} task: ${run.taskTitle}
metadata:
  type: feedback
---

**Failed Task:** ${run.taskTitle}
**Worker:** ${run.worker}
**Date:** ${run.startedAt || new Date().toISOString()}
**Run ID:** ${runId}

${analysis}

**Why:** Task failed during automated execution run.
**How to apply:** Before running similar tasks with ${run.worker}, verify these conditions are met.
`;

    writeFileSync(lessonFile, memory);
    appendToIndex(lessonFile, `Lesson: ${run.taskTitle}`, `Failure analysis for ${run.worker}`);
    console.log(`Saved: ${lessonFile}`);
    saved++;

    await new Promise(r => setTimeout(r, 1500));
  }

  console.log(`Self-improvement complete. ${saved} lesson(s) saved.`);
}

main().catch(err => { console.error('Fatal:', err.message); process.exit(1); });
