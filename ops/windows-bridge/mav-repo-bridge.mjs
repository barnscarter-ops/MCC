import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const port = Number(process.env.MAV_REPO_BRIDGE_PORT || 8790);
const host = process.env.MAV_REPO_BRIDGE_HOST || '0.0.0.0';
const defaultRepo = process.env.MAV_REPO_DEFAULT || 'C:\\Workspace\\Active\\homelab-noc-dashboard\\homelab-noc-dashboard\\homelab-noc-dashboard';
const seoAppPath = process.env.MAV_SEO_APP_PATH || 'C:\\Workspace\\Active\\SEO-Agents-App';
const memoryPath = process.env.MAV_MEMORY_PATH || 'C:\\Users\\carte\\.claude\\projects\\memory';
const allowedRoots = (process.env.MAV_REPO_ALLOWED_ROOTS || 'C:\\Workspace\\Active;C:\\Users\\carte\\CodeProjects')
  .split(';')
  .map((item) => path.resolve(item.trim()))
  .filter(Boolean);
const hermesExe = process.env.HERMES_EXE || 'C:\\Users\\carte\\AppData\\Local\\hermes\\hermes-agent\\venv\\Scripts\\hermes.exe';
// Lean Hermes profile for worker spawns (max_turns 20, low reasoning effort,
// no memory/curator/LSP). Set to '' to use the default desktop profile.
const hermesProfile = process.env.MAV_HERMES_PROFILE ?? 'worker';
const defaultTimeoutMs = Number(process.env.MAV_REPO_HERMES_TIMEOUT_MS || 300_000);
const maxBodyBytes = Number(process.env.MAV_REPO_MAX_BODY_BYTES || 160_000);
const maxDiffBytes = Number(process.env.MAV_REPO_MAX_DIFF_BYTES || 120_000);
const maxHermenPromptChars = Number(process.env.MAV_REPO_HERMEN_MAX_PROMPT_CHARS || 12_000);
const maxHermenChangedFiles = Number(process.env.MAV_REPO_HERMEN_MAX_CHANGED_FILES || 6);
const minHermenTimeoutMs = Number(process.env.MAV_REPO_HERMEN_MIN_TIMEOUT_MS || 180_000);
const maxHermenTimeoutMs = Number(process.env.MAV_REPO_HERMEN_MAX_TIMEOUT_MS || 600_000);
const claudeExe = process.env.CLAUDE_EXE || 'C:\\Users\\carte\\AppData\\Roaming\\npm\\claude.cmd';
const claudeManagerModel = process.env.CLAUDE_MANAGER_MODEL || 'sonnet';
const claudeManagerTimeoutMs = Number(process.env.CLAUDE_MANAGER_TIMEOUT_MS || 180_000);

function sendJson(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store'
  });
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  let body = '';
  for await (const chunk of req) {
    body += chunk;
    if (body.length > maxBodyBytes) throw new Error('Request body too large');
  }
  return body ? JSON.parse(body) : {};
}

function resolveRepo(repoPath = defaultRepo) {
  const resolved = path.resolve(repoPath);
  const allowed = allowedRoots.some((root) => resolved === root || resolved.startsWith(`${root}${path.sep}`));
  if (!allowed) {
    throw new Error(`Repo path is outside allowed roots: ${resolved}`);
  }
  if (!fs.existsSync(resolved)) {
    throw new Error(`Repo path does not exist: ${resolved}`);
  }
  return resolved;
}

function runCommand(command, args, { cwd, timeoutMs = 20_000, maxBytes = 80_000, stdin = null } = {}) {
  const started = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stdout = '';
    let stderr = '';
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error(`${command} timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      if (stdout.length > maxBytes) stdout = `${stdout.slice(0, maxBytes)}\n[truncated]`;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
      if (stderr.length > maxBytes) stderr = `${stderr.slice(0, maxBytes)}\n[truncated]`;
    });
    if (stdin != null) {
      child.stdin.end(stdin);
    }
    child.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timeout);
      resolve({
        command,
        args,
        cwd,
        exitCode: code,
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        durationMs: Date.now() - started
      });
    });
  });
}

function clampHermenTimeout(timeoutMs) {
  const requested = Number(timeoutMs || defaultTimeoutMs);
  if (!Number.isFinite(requested)) return defaultTimeoutMs;
  return Math.max(minHermenTimeoutMs, Math.min(maxHermenTimeoutMs, requested));
}

function buildHermenPrompt(prompt, { repoPath }) {
  return `You are Hermen, a scoped local coding agent running inside this repository:
${repoPath}

Hard limits for this pass:
- Keep this to one focused implementation pass.
- Inspect only files directly needed for the task. Do not read generated folders, node_modules, dist, build output, or broad repository dumps.
- Modify at most ${maxHermenChangedFiles} source/config files.
- If the task needs more files, deployment, secrets, browser verification, or broad refactoring, stop and report BLOCKED with the exact reason.
- Keep your working context compact. Prefer rg/git diff/stat and targeted line reads over full-file reads.
- Before your final response, run git diff --stat if you changed files.
- Final response must start with one of: COMPLETED, PARTIAL, BLOCKED.

Task:
${prompt}`;
}

function classifyHermenFailure(error) {
  const message = String(error?.message || error || '');
  if (/prompt too large/i.test(message)) return 'prompt_too_large';
  if (/timed out/i.test(message)) return 'timeout';
  if (/exceeds the available context size|context length exceeded|Cannot compress further/i.test(message)) return 'context_overflow';
  if (/Unrepairable tool_call|tool_call arguments|final_response/i.test(message)) return 'tool_call_format';
  if (/exited with/i.test(message)) return 'process_exit';
  return 'unknown';
}

function extractJsonObject(rawText) {
  const jsonMatch = String(rawText || '').match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try {
    return JSON.parse(jsonMatch[0]);
  } catch {
    return null;
  }
}

function quoteCmdArg(value) {
  return `"${String(value).replace(/"/g, '""')}"`;
}

async function runClaudeManager({ idea, task, mode, repoPath }) {
  if (!fs.existsSync(claudeExe)) {
    throw new Error(`Claude executable not found: ${claudeExe}`);
  }
  const prompt = `You are Claude CLI acting as lead engineer and prompt manager for Hermen, a local Qwen coding worker.

Your job is planning only. Do not implement. Do not ask to modify files. Produce one compact work order that Hermen can execute without overflowing local context.

Return only JSON with this shape:
{
  "status": "ready|blocked",
  "summary": "one sentence",
  "harmen_prompt": "compact executable prompt under 3500 characters",
  "qc_checks": ["verification Codex should run after Hermen"]
}

Rules:
- Codex is final QC.
- Do not create plan files or persistent session artifacts.
- Keep the Hermen prompt to one focused pass.
- Do not ask Hermen to read broad directories, node_modules, dist, build output, or unrelated files.
- If the request needs multiple passes, set status to "blocked" and make harmen_prompt the first safe pass only.
- For brief mode, Harmen must inspect/recommend only.
- For implement mode, Harmen may edit only when the assigned task explicitly asks for implementation.

Repository:
${repoPath}

Mode:
${mode}

Product/request:
${idea}

Assigned task:
${task.title}

Routing reason:
${task.reason || 'No reason supplied.'}`;
  const commandLine = [
    'claude',
    '-p',
    '--model',
    claudeManagerModel,
    '--permission-mode',
    'default',
    '--max-budget-usd',
    '0.75'
  ].join(' ');
  const result = await runCommand(process.env.ComSpec || 'cmd.exe', ['/d', '/c', commandLine], {
    cwd: repoPath,
    timeoutMs: claudeManagerTimeoutMs,
    maxBytes: 40_000,
    stdin: prompt
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `Claude manager exited with ${result.exitCode}`);
  }
  const parsed = extractJsonObject(result.stdout);
  const fallbackPrompt = String(result.stdout || '').trim().slice(0, 5000);
  return {
    raw: result.stdout,
    status: parsed?.status || 'ready',
    summary: parsed?.summary || fallbackPrompt.split(/\r?\n/).find(Boolean) || '',
    harmenPrompt: String(parsed?.harmen_prompt || fallbackPrompt).slice(0, 5000),
    qcChecks: Array.isArray(parsed?.qc_checks) ? parsed.qc_checks.slice(0, 8) : ['Review Hermen output', 'Review git diff', 'Run focused verification'],
    durationMs: result.durationMs,
    createdAt: new Date().toISOString()
  };
}

async function git(repoPath, args, options = {}) {
  const result = await runCommand('git', args, { cwd: repoPath, ...options });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `git ${args.join(' ')} failed`);
  }
  return result.stdout;
}

function parseStatusPorcelain(output) {
  if (!output) return [];
  return output.split(/\r?\n/).filter(Boolean).map((line) => ({
    code: line.slice(0, 2),
    path: line.slice(2).trimStart()
  }));
}

function parseMemoryFrontmatter(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) return null;
  const frontmatter = match[1];
  const body = match[2].trim();
  const metadata = {};
  let inMetadata = false;
  const parsed = {};
  for (const rawLine of frontmatter.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.trim() === 'metadata:') {
      inMetadata = true;
      continue;
    }
    const keyValue = line.match(/^\s*([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!keyValue) continue;
    const [, key, rawValue] = keyValue;
    const value = rawValue.replace(/^["']|["']$/g, '');
    if (inMetadata && rawLine.startsWith('  ')) {
      metadata[key] = value;
    } else {
      inMetadata = false;
      parsed[key] = value;
    }
  }
  return { ...parsed, metadata, body };
}

function redactMemoryBody(body) {
  return body
    .replace(/(?:ssh|api[_ -]?key|private[_ -]?key|token|secret|credential|password|root|id_ed25519)[^\r\n]*/gi, '[redacted sensitive reference]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[redacted ip]');
}

function loadMemoryIndex() {
  if (!fs.existsSync(memoryPath)) {
    return {
      sourcePath: memoryPath,
      state: 'missing',
      memories: [],
      warnings: [`Memory path not found: ${memoryPath}`],
      updatedAt: new Date().toISOString()
    };
  }
  const warnings = [];
  const files = fs.readdirSync(memoryPath).filter((file) => file.toLowerCase().endsWith('.md')).sort();
  const memories = files.flatMap((file) => {
    const sourcePath = path.join(memoryPath, file);
    try {
      const parsed = parseMemoryFrontmatter(fs.readFileSync(sourcePath, 'utf8'));
      if (!parsed?.name) {
        warnings.push(`Skipped ${file}: missing frontmatter name.`);
        return [];
      }
      const related = [...parsed.body.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1]);
      const stat = fs.statSync(sourcePath);
      return [{
        id: parsed.name,
        description: parsed.description || '',
        type: parsed.metadata?.type || 'unknown',
        nodeType: parsed.metadata?.node_type || 'memory',
        originSessionId: parsed.metadata?.originSessionId || null,
        related,
        body: redactMemoryBody(parsed.body),
        sourcePath,
        updatedAt: stat.mtime.toISOString()
      }];
    } catch (error) {
      warnings.push(`Skipped ${file}: ${error.message}`);
      return [];
    }
  });
  const typeCounts = memories.reduce((counts, memory) => {
    counts[memory.type] = (counts[memory.type] || 0) + 1;
    return counts;
  }, {});
  return {
    sourcePath: memoryPath,
    state: 'online',
    count: memories.length,
    typeCounts,
    memories,
    warnings,
    updatedAt: new Date().toISOString()
  };
}

function searchMemory(query) {
  const index = loadMemoryIndex();
  const terms = String(query || '').toLowerCase().split(/\s+/).filter((term) => term.length > 2);
  if (!terms.length) return { ...index, results: index.memories.slice(0, 8) };
  const results = index.memories.map((memory) => {
    const haystack = `${memory.id} ${memory.description} ${memory.type} ${memory.body}`.toLowerCase();
    const score = terms.reduce((total, term) => total + (haystack.includes(term) ? 1 : 0), 0);
    return { ...memory, score };
  }).filter((memory) => memory.score > 0);
  results.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
  return { ...index, results: results.slice(0, 8) };
}

function readMarkdownFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  const stat = fs.statSync(filePath);
  return {
    name: path.basename(filePath),
    path: filePath,
    updatedAt: stat.mtime.toISOString(),
    createdAt: stat.birthtime.toISOString(),
    size: stat.size,
    text: fs.readFileSync(filePath, 'utf8')
  };
}

function extractStatusCounts(text) {
  const statuses = ['COMPLETE', 'PARTIAL', 'BLOCKED', 'INCOMPLETE'];
  return statuses.reduce((counts, status) => {
    const matches = text.match(new RegExp(`\\b${status}\\b`, 'gi'));
    counts[status.toLowerCase()] = matches ? matches.length : 0;
    return counts;
  }, {});
}

function extractHeadings(text, limit = 8) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, ''))
    .slice(0, limit);
}

function reportDisplayTitle(report) {
  const firstHeading = extractHeadings(report.text, 1)[0] || report.name.replace(/_/g, ' ');
  const date = new Date(report.updatedAt);
  const dateText = Number.isFinite(date.getTime()) ? date.toLocaleDateString('en-US') : '';
  return firstHeading.replace(/\[Date\]/g, dateText);
}

function firstNonEmptyLines(text, limit = 4) {
  return text.split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#') && !line.startsWith('---'))
    .slice(0, limit);
}

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    return { error: `Could not parse ${path.basename(filePath)}: ${error.message}` };
  }
}

function workflowPhaseLabel(statusPayload, fallback) {
  if (!statusPayload || statusPayload.error) return fallback;
  const labels = {
    complete: 'Complete',
    failed: 'Failed',
    needs_owner_review: 'Needs owner review',
    ready_to_execute: 'Ready for execution',
    pending: 'Research needed'
  };
  return labels[statusPayload.status] || statusPayload.status || fallback;
}

function workflowCountsFromStatus(statusPayload, fallbackCounts) {
  const summary = statusPayload?.summary || {};
  return {
    ...fallbackCounts,
    complete: summary.count_verified ?? fallbackCounts.complete ?? 0,
    partial: summary.count_partial ?? fallbackCounts.partial ?? 0,
    blocked: fallbackCounts.blocked ?? 0,
    incomplete: summary.count_incomplete ?? fallbackCounts.incomplete ?? 0
  };
}

function completedTaskIds(statusPayload) {
  const tasks = statusPayload?.summary?.tasks || [];
  return new Set(tasks
    .filter((task) => {
      const status = String(task.status || '').toUpperCase();
      const definition = String(task.definition_of_done || '').toUpperCase();
      return ['COMPLETE', 'COMPLETED', 'VERIFIED'].includes(status) && definition === 'YES';
    })
    .map((task) => String(task.id || '').toUpperCase())
    .filter(Boolean));
}

function pendingOwnerSignoffs(statusPayload, doneTaskIds) {
  return (statusPayload?.summary?.owner_signoffs_needed || [])
    .filter((item) => {
      const taskId = String(item).match(/\bT\d{3}\b/i)?.[0]?.toUpperCase();
      return !taskId || !doneTaskIds.has(taskId);
    });
}

function pendingQueueHeadings(queueReport, doneTaskIds) {
  if (!queueReport) return [];
  return extractHeadings(queueReport.text, 5)
    .filter((heading) => {
      const taskId = String(heading).match(/\bT\d{3}\b/i)?.[0]?.toUpperCase();
      if (taskId) return !doneTaskIds.has(taskId);
      if (/repair contact form|fix broken contact form/i.test(String(heading)) && doneTaskIds.has('T002')) return false;
      if (/^Execution Queue$/i.test(String(heading))) return false;
      return true;
    });
}

function loadSeoWorkflow() {
  const outputsDir = path.join(seoAppPath, 'outputs');
  if (!fs.existsSync(outputsDir)) {
    return {
      state: 'missing',
      appPath: seoAppPath,
      outputsDir,
      reports: [],
      faults: [`SEO outputs path not found: ${outputsDir}`],
      updatedAt: new Date().toISOString()
    };
  }

  const reportNames = [
    'grizzly_local_presence_plan.md',
    'grizzly_execution_queue.md',
    'final_report.md',
    'gbp_posting_schedule.md',
    'website_report.md',
    'gbp_report.md',
    'reputation_report.md',
    'content_report.md',
    'technical_completion.md',
    'content_completion.md',
    'assets_completion.md',
    'delegation_verification.md'
  ];
  const reports = reportNames.flatMap((name) => {
    const report = readMarkdownFile(path.join(outputsDir, name));
    if (!report) return [];
    return [{
      name: report.name,
      updatedAt: report.updatedAt,
      createdAt: report.createdAt,
      size: report.size,
      displayTitle: reportDisplayTitle(report),
      headings: extractHeadings(report.text, 6),
      summary: firstNonEmptyLines(report.text, 3),
      statusCounts: extractStatusCounts(report.text)
    }];
  });
  const sevenDaysAgo = Date.now() - (7 * 24 * 60 * 60 * 1000);
  const reportsLast7Days = reports.filter((report) => {
    const reportTime = new Date(report.updatedAt).getTime();
    return Number.isFinite(reportTime) && reportTime >= sevenDaysAgo;
  });

  const allText = reports.map((report) => `${report.name}\n${report.summary.join('\n')}\n${report.headings.join('\n')}`).join('\n\n');
  const finalReport = readMarkdownFile(path.join(outputsDir, 'final_report.md'));
  const queueReport = readMarkdownFile(path.join(outputsDir, 'grizzly_execution_queue.md'));
  const scheduleReport = readMarkdownFile(path.join(outputsDir, 'gbp_posting_schedule.md'));
  const workflowStatus = readJsonFile(path.join(outputsDir, 'workflow_status.json'));
  const runHealth = readJsonFile(path.join(outputsDir, 'run_health.json'));
  const markdownStatusCounts = extractStatusCounts([
    finalReport?.text || '',
    readMarkdownFile(path.join(outputsDir, 'content_completion.md'))?.text || '',
    readMarkdownFile(path.join(outputsDir, 'assets_completion.md'))?.text || '',
    readMarkdownFile(path.join(outputsDir, 'technical_completion.md'))?.text || ''
  ].join('\n'));
  const statusCounts = workflowCountsFromStatus(workflowStatus, markdownStatusCounts);
  const faults = [];
  // Run health faults — surface failed phases immediately so MCC shows a red badge
  if (runHealth) {
    for (const [phase, entry] of Object.entries(runHealth)) {
      if (entry?.status === 'failed') {
        const label = { research: 'Research', execute: 'Execution', post_schedule: 'GBP Post Schedule' }[phase] || phase;
        const errMsg = entry.error ? `: ${entry.error.slice(0, 120)}` : '';
        faults.push(`⚠ ${label} run FAILED${errMsg}`);
      }
    }
  }
  for (const reportName of ['final_report.md', 'grizzly_execution_queue.md', 'gbp_posting_schedule.md']) {
    if (!fs.existsSync(path.join(outputsDir, reportName))) faults.push(`Missing ${reportName}`);
  }
  if (/\bBLOCKED\b/i.test(finalReport?.text || '')) faults.push('Final report contains blocked work');
  if (/\bNEEDS PHOTO\b/i.test(scheduleReport?.text || '')) faults.push('GBP schedule contains photo gaps');
  if (workflowStatus?.error) faults.push(workflowStatus.error);
  const doneTaskIds = completedTaskIds(workflowStatus);
  const ownerSignoffs = pendingOwnerSignoffs(workflowStatus, doneTaskIds);

  return {
    state: 'online',
    source: workflowStatus && !workflowStatus.error ? 'workflow-status' : 'markdown-scan',
    appPath: seoAppPath,
    outputsDir,
    reportCount: reports.length,
    latestReportAt: reports.map((report) => report.updatedAt).sort().at(-1) || null,
    reports,
    reportCountLast7Days: reportsLast7Days.length,
    statusCounts,
    activeWorkflow: {
      name: 'Grizzly SEO Automation',
      phase: workflowPhaseLabel(workflowStatus, finalReport ? 'Execution reviewed' : queueReport ? 'Ready for execution' : 'Research needed'),
      reportsGenerated: reportsLast7Days.length
    },
    workflowStatus,
    runHealth,
    nextAction: workflowStatus?.next_action || null,
    ownerSignoffs,
    taskSummary: workflowStatus?.summary || null,
    upcomingActions: [
      ...ownerSignoffs,
      ...pendingQueueHeadings(queueReport, doneTaskIds),
      ...(scheduleReport ? extractHeadings(scheduleReport.text, 3) : [])
    ].slice(0, 8),
    faults,
    sourceDigest: allText.slice(0, 4000),
    updatedAt: new Date().toISOString()
  };
}

async function repoSnapshot(repoPath) {
  const [branch, commit, statusText, changedText, statText] = await Promise.all([
    git(repoPath, ['branch', '--show-current']).catch(() => ''),
    git(repoPath, ['rev-parse', '--short', 'HEAD']).catch(() => ''),
    git(repoPath, ['status', '--short']),
    git(repoPath, ['diff', '--name-only']).catch(() => ''),
    git(repoPath, ['diff', '--stat']).catch(() => '')
  ]);
  return {
    repoPath,
    branch,
    commit,
    dirty: Boolean(statusText.trim()),
    status: parseStatusPorcelain(statusText),
    changedFiles: changedText.split(/\r?\n/).filter(Boolean),
    diffStat: statText
  };
}

async function repoDiff(repoPath) {
  return git(repoPath, ['diff', '--', '.'], { maxBytes: maxDiffBytes });
}

// Serialize all Hermen runs: the local llama-server has a small fixed number of
// KV-cache slots, and two concurrent agentic workers evict each other's cache,
// forcing full prompt reprocessing every turn. Queued runs wait their turn.
let hermesLock = Promise.resolve();
function withHermesLock(fn) {
  const run = hermesLock.then(fn, fn);
  hermesLock = run.then(() => {}, () => {});
  return run;
}

async function runHermes(prompt, { repoPath, timeoutMs = defaultTimeoutMs, toolsets = 'terminal,file' } = {}) {
  if (!fs.existsSync(hermesExe)) {
    throw new Error(`Hermes executable not found: ${hermesExe}`);
  }
  const started = Date.now();
  if (prompt.length > maxHermenPromptChars) {
    throw new Error(`Hermen prompt too large: ${prompt.length} chars exceeds ${maxHermenPromptChars}. Split the task into a smaller scoped pass.`);
  }
  const guardedPrompt = buildHermenPrompt(prompt, { repoPath });
  const childArgs = [
    ...(hermesProfile ? ['-p', hermesProfile] : []),
    '-z', guardedPrompt,
    '--toolsets', toolsets
  ];
  const result = await withHermesLock(() => runCommand(hermesExe, childArgs, {
    cwd: repoPath,
    timeoutMs: clampHermenTimeout(timeoutMs),
    maxBytes: 120_000
  }));
  return {
    output: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
    failureType: result.exitCode === 0 ? null : classifyHermenFailure(result.stderr || result.stdout || `Hermes exited with ${result.exitCode}`),
    durationMs: Date.now() - started,
    createdAt: new Date().toISOString()
  };
}

async function runSeoAgentCommand(args, { timeoutMs = 180_000 } = {}) {
  const pythonPath = path.join(seoAppPath, '.venv', 'Scripts', 'python.exe');
  const command = fs.existsSync(pythonPath) ? pythonPath : 'python';
  const result = await runCommand(command, ['-m', 'seo_agents.main', ...args], {
    cwd: seoAppPath,
    timeoutMs,
    maxBytes: 120_000
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || `seo-agents ${args.join(' ')} failed`);
  }
  return result;
}

async function seoCommandJson(args, options = {}) {
  const result = await runSeoAgentCommand(args, options);
  try {
    return {
      ...JSON.parse(result.stdout || '{}'),
      command: `seo-agents ${args.join(' ')}`,
      durationMs: result.durationMs
    };
  } catch (error) {
    throw new Error(`Could not parse seo-agents JSON output: ${error.message}`);
  }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  try {
    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, {
        state: 'online',
        defaultRepo,
        seoAppPath,
        allowedRoots,
        memoryPath,
        hermes: fs.existsSync(hermesExe) ? 'available' : 'missing',
        claude: fs.existsSync(claudeExe) ? 'available' : 'missing',
        port
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/repo/status') {
      const repoPath = resolveRepo(url.searchParams.get('repo') || defaultRepo);
      sendJson(res, 200, await repoSnapshot(repoPath));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/repo/diff') {
      const repoPath = resolveRepo(url.searchParams.get('repo') || defaultRepo);
      sendJson(res, 200, { repoPath, diff: await repoDiff(repoPath) });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/worker/hermen/run') {
      const { prompt, repo, timeoutMs, toolsets } = await readJsonBody(req);
      if (!prompt || typeof prompt !== 'string') {
        sendJson(res, 400, { error: 'prompt is required.' });
        return;
      }
      const repoPath = resolveRepo(repo || defaultRepo);
      const before = await repoSnapshot(repoPath);
      let result;
      let runError = null;
      try {
        result = await runHermes(prompt, { repoPath, timeoutMs, toolsets });
      } catch (error) {
        runError = error;
        result = {
          output: '',
          stderr: error.message,
          exitCode: 1,
          failureType: classifyHermenFailure(error),
          durationMs: null,
          createdAt: new Date().toISOString()
        };
      }
      const after = await repoSnapshot(repoPath);
      const diff = await repoDiff(repoPath).catch((error) => `diff unavailable: ${error.message}`);
      const beforeFiles = new Set(before.changedFiles);
      const changedFilesDelta = after.changedFiles.filter((file) => !beforeFiles.has(file));
      const changedFiles = before.dirty ? changedFilesDelta : after.changedFiles;
      const changedFileLimitExceeded = changedFiles.length > maxHermenChangedFiles;
      const payload = {
        ...result,
        repoPath,
        before,
        after,
        baselineDirty: before.dirty,
        allChangedFiles: after.changedFiles,
        changedFiles,
        changedFilesDelta,
        changedFileLimitExceeded,
        maxChangedFiles: maxHermenChangedFiles,
        diffStat: after.diffStat,
        diff,
        status: runError ? 'partial_or_failed' : changedFileLimitExceeded ? 'needs_review' : 'completed'
      };
      sendJson(res, runError ? 500 : 200, payload);
      return;
    }

    if (req.method === 'POST' && url.pathname === '/worker/claude-manager') {
      const { idea, task, mode = 'brief', repo } = await readJsonBody(req);
      if (!idea || !task?.title) {
        sendJson(res, 400, { error: 'idea and task.title are required.' });
        return;
      }
      const repoPath = resolveRepo(repo || defaultRepo);
      const result = await runClaudeManager({ idea, task, mode, repoPath });
      sendJson(res, 200, { ...result, repoPath });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/memory') {
      const query = url.searchParams.get('query');
      sendJson(res, 200, query ? searchMemory(query) : loadMemoryIndex());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/seo/status') {
      sendJson(res, 200, loadSeoWorkflow());
      return;
    }

    if (req.method === 'GET' && url.pathname === '/seo/actions') {
      sendJson(res, 200, await seoCommandJson(['actions', '--json']));
      return;
    }

    if (req.method === 'POST' && url.pathname === '/seo/actions/approve') {
      const { actionId, approvedBy = 'MCC', note = '' } = await readJsonBody(req);
      if (!actionId || typeof actionId !== 'string') {
        sendJson(res, 400, { error: 'actionId is required.' });
        return;
      }
      const result = await runSeoAgentCommand(['approve-action', actionId, '--by', approvedBy, '--note', note], { timeoutMs: 180_000 });
      sendJson(res, 200, {
        state: 'approved',
        actionId,
        output: result.stdout,
        command: `seo-agents approve-action ${actionId}`,
        durationMs: result.durationMs
      });
      return;
    }

    if (req.method === 'POST' && url.pathname === '/seo/actions/run') {
      const { actionId, live = false } = await readJsonBody(req);
      if (!actionId || typeof actionId !== 'string') {
        sendJson(res, 400, { error: 'actionId is required.' });
        return;
      }
      const args = ['run-action', actionId];
      if (live) args.push('--live');
      sendJson(res, 200, await seoCommandJson(args, { timeoutMs: 600_000 }));
      return;
    }

    sendJson(res, 404, { error: 'not found' });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
});

server.listen(port, host, () => {
  console.log(`mav repo bridge listening on http://${host}:${port}`);
  console.log(`Default repo: ${defaultRepo}`);
  console.log(`Allowed roots: ${allowedRoots.join('; ')}`);
});
