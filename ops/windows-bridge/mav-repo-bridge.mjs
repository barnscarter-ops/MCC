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
const defaultTimeoutMs = Number(process.env.MAV_REPO_HERMES_TIMEOUT_MS || 300_000);
const maxBodyBytes = Number(process.env.MAV_REPO_MAX_BODY_BYTES || 160_000);
const maxDiffBytes = Number(process.env.MAV_REPO_MAX_DIFF_BYTES || 120_000);

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

function runCommand(command, args, { cwd, timeoutMs = 20_000, maxBytes = 80_000 } = {}) {
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
  const markdownStatusCounts = extractStatusCounts([
    finalReport?.text || '',
    readMarkdownFile(path.join(outputsDir, 'content_completion.md'))?.text || '',
    readMarkdownFile(path.join(outputsDir, 'assets_completion.md'))?.text || '',
    readMarkdownFile(path.join(outputsDir, 'technical_completion.md'))?.text || ''
  ].join('\n'));
  const statusCounts = workflowCountsFromStatus(workflowStatus, markdownStatusCounts);
  const faults = [];
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

async function runHermes(prompt, { repoPath, timeoutMs = defaultTimeoutMs, toolsets = 'terminal,file,hermes-cli' } = {}) {
  if (!fs.existsSync(hermesExe)) {
    throw new Error(`Hermes executable not found: ${hermesExe}`);
  }
  const started = Date.now();
  const childArgs = ['-z', prompt, '--toolsets', toolsets];
  const result = await runCommand(hermesExe, childArgs, {
    cwd: repoPath,
    timeoutMs,
    maxBytes: 120_000
  });
  return {
    output: result.stdout,
    stderr: result.stderr,
    exitCode: result.exitCode,
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
      const result = await runHermes(prompt, { repoPath, timeoutMs, toolsets });
      const after = await repoSnapshot(repoPath);
      const diff = await repoDiff(repoPath).catch((error) => `diff unavailable: ${error.message}`);
      const beforeFiles = new Set(before.changedFiles);
      const changedFilesDelta = after.changedFiles.filter((file) => !beforeFiles.has(file));
      sendJson(res, 200, {
        ...result,
        repoPath,
        before,
        after,
        baselineDirty: before.dirty,
        allChangedFiles: after.changedFiles,
        changedFiles: before.dirty ? changedFilesDelta : after.changedFiles,
        changedFilesDelta,
        diffStat: after.diffStat,
        diff
      });
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
      sendJson(res, 200, await seoCommandJson(args, { timeoutMs: 240_000 }));
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
