import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { workspacePath, skillsPath, anthropicApiKey, anthropicModel, braveApiKey, BLOCKED_ABS_RE } from '../config.mjs';

const BLOCKED_REL = /^(\.env$|\.git(\/|$)|node_modules(\/|$)|package-lock\.json$|tmp(\/|$)|\.mav-console(\/|$))/i;

export function resolveSafePath(p) {
  if (!p || typeof p !== 'string') return null;
  const trimmed = p.trim();
  let abs;
  if (path.isAbsolute(trimmed)) {
    abs = path.normalize(trimmed);
  } else {
    const rel = path.normalize(trimmed.replace(/^[/\\]+/, ''));
    if (rel.split(/[/\\]/).includes('..')) return null;
    if (BLOCKED_REL.test(rel.replace(/\\/g, '/'))) return null;
    abs = path.join(workspacePath, rel);
  }
  if (BLOCKED_ABS_RE.test(abs)) return null;
  return abs;
}

export const EXEC_TOOLS = [
  { type: 'function', function: { name: 'list_dir', description: 'List files in a directory. Accepts absolute paths (e.g. C:\\Workspace\\MyProject) or relative paths from the MCC root. Directories end with /.', parameters: { type: 'object', properties: { path: { type: 'string', description: 'Absolute or relative directory path.' } }, required: [] } } },
  { type: 'function', function: { name: 'read_file', description: 'Read a text file. Accepts absolute or relative paths. Returns up to 6000 characters; use offset to page through large files.', parameters: { type: 'object', properties: { path: { type: 'string' }, offset: { type: 'number' } }, required: ['path'] } } },
  { type: 'function', function: { name: 'write_file', description: 'Stage a file for human review — nothing is written until the user clicks APPLY. Content must be the complete file, never a partial snippet. Accepts absolute or relative paths.', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } } },
  { type: 'function', function: { name: 'run_command', description: 'Run a command in the MCC workspace. No shell operators (| ; && > etc). Useful for: node, npm, npx, git, pm2 list/logs/status, python, dir.', parameters: { type: 'object', properties: { command: { type: 'string' } }, required: ['command'] } } },
  { type: 'function', function: { name: 'fetch_url', description: 'Fetch the content of any public URL and return it as plain text. Strips HTML tags. Good for reading documentation, API responses, JSON feeds, or checking if a URL is reachable. Returns up to 4000 characters.', parameters: { type: 'object', properties: { url: { type: 'string', description: 'Full URL including https://' } }, required: ['url'] } } },
  { type: 'function', function: { name: 'web_search', description: 'Search the web using Brave Search API. Returns top 5 results with titles, URLs, and descriptions. Use when you need current information, package docs, error solutions, or anything you cannot find in local files.', parameters: { type: 'object', properties: { query: { type: 'string', description: 'Search query' } }, required: ['query'] } } }
];

const BLOCKED_COMMANDS = /(\brmdir\b|\bdel\b|\brd\b|\brm\b|\bformat\b|\bregdel\b|\bpowershell.*-enc\b|\bcurl.*\|\s*bash\b)/i;
const SAFE_COMMAND = /^(node|npm|npx|git|pm2|python|python3|dir|type|where|echo|ping|tracert|nslookup|ipconfig)\b/i;

function runShellCommand(command) {
  return new Promise((resolve) => {
    const child = spawn('cmd.exe', ['/d', '/s', '/c', command], { cwd: workspacePath });
    let out = '';
    let killed = false;
    const timer = setTimeout(() => { killed = true; child.kill(); }, 120_000);
    child.stdout.on('data', (d) => { if (out.length < 8000) out += d; });
    child.stderr.on('data', (d) => { if (out.length < 8000) out += d; });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(`exit code: ${code}${killed ? ' (killed after 120s)' : ''}\n${out.slice(0, 6000) || '(no output)'}`);
    });
    child.on('error', (err) => { clearTimeout(timer); resolve(`ERROR: ${err.message}`); });
  });
}

export async function runExecTool(name, args, staged) {
  if (name === 'run_command') {
    const cmd = String(args.command || '').trim();
    if (/[;&|<>`$^%]/.test(cmd)) return 'ERROR: shell operators are not allowed';
    if (BLOCKED_COMMANDS.test(cmd)) return 'ERROR: command is blocked for safety.';
    if (!SAFE_COMMAND.test(cmd)) return 'ERROR: command not recognised. Allowed prefixes: node, npm, npx, git, pm2, python, python3, dir, type, where, echo, ping, tracert, nslookup, ipconfig.';
    return runShellCommand(cmd);
  }
  if (name === 'list_dir') {
    const abs = resolveSafePath(args.path || '.');
    if (abs === null) return 'ERROR: path not allowed';
    try {
      const entries = fs.readdirSync(abs, { withFileTypes: true });
      return entries
        .filter((e) => !['node_modules', '.git', 'dist', 'tmp', '.mav-console'].includes(e.name))
        .slice(0, 100)
        .map((e) => e.name + (e.isDirectory() ? '/' : ''))
        .join('\n') || '(empty)';
    } catch (error) {
      return `ERROR: ${error.message}`;
    }
  }
  if (name === 'read_file') {
    const abs = resolveSafePath(args.path);
    if (abs === null) return 'ERROR: path not allowed';
    const stagedFile = staged.files.find((f) => f.path === abs);
    let text;
    if (stagedFile) {
      text = stagedFile.content;
    } else {
      try { text = fs.readFileSync(abs, 'utf8'); }
      catch (error) { return `ERROR: ${error.message}`; }
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const slice = text.slice(offset, offset + 6000);
    staged.readPaths.add(abs);
    return text.length > offset + 6000
      ? `${slice}\n...[truncated, file is ${text.length} chars — call read_file with offset=${offset + 6000} for the rest]`
      : slice;
  }
  if (name === 'write_file') {
    const abs = resolveSafePath(args.path);
    if (abs === null) return 'ERROR: path not allowed';
    if (typeof args.content !== 'string' || !args.content.trim()) return 'ERROR: content is required';
    try {
      const oldSize = fs.statSync(abs).size;
      if (oldSize > 400 && args.content.length < oldSize * 0.3) {
        return `REJECTED: ${abs} is ${oldSize} bytes but your content is only ${args.content.length} chars. write_file requires the COMPLETE updated file — read_file it first, then resubmit the whole file with your change merged in.`;
      }
      if (!staged.readPaths.has(abs)) {
        return `REJECTED: ${abs} already exists — read_file it before writing so your version preserves existing code.`;
      }
    } catch {}
    const index = staged.files.findIndex((f) => f.path === abs);
    const entry = { path: abs, content: args.content };
    if (index >= 0) staged.files[index] = entry; else staged.files.push(entry);
    return `STAGED ${abs} (${args.content.length} chars). It will be applied to the workspace after human review.`;
  }
  if (name === 'fetch_url') {
    const url = String(args.url || '').trim();
    if (!url.startsWith('http://') && !url.startsWith('https://')) return 'ERROR: URL must start with http:// or https://';
    try {
      const r = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; MaverickMCC/1.0)' },
        signal: AbortSignal.timeout(15_000)
      });
      if (!r.ok) return `ERROR: HTTP ${r.status} from ${url}`;
      const ct = r.headers.get('content-type') || '';
      const raw = await r.text();
      if (ct.includes('json') || url.endsWith('.json')) return raw.slice(0, 4000);
      const stripped = raw
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
      return stripped.length > 4000 ? stripped.slice(0, 4000) + '\n...[truncated]' : stripped;
    } catch (err) { return `ERROR: ${err.message}`; }
  }
  if (name === 'web_search') {
    if (!braveApiKey) return 'ERROR: Web search not configured. Add BRAVE_SEARCH_API_KEY to .env — free key at brave.com/search/api/';
    const query = String(args.query || '').trim();
    if (!query) return 'ERROR: query is required';
    try {
      const r = await fetch(`https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`, {
        headers: { 'Accept': 'application/json', 'X-Subscription-Token': braveApiKey },
        signal: AbortSignal.timeout(10_000)
      });
      if (!r.ok) return `ERROR: Brave API ${r.status} — ${await r.text().catch(() => '')}`;
      const data = await r.json();
      const results = (data.web?.results || []).slice(0, 5)
        .map((res, i) => `${i + 1}. ${res.title}\n   ${res.url}\n   ${res.description || ''}`)
        .join('\n\n');
      return results || 'No results found';
    } catch (err) { return `ERROR: ${err.message}`; }
  }
  return `ERROR: unknown tool ${name}`;
}

export async function runOpsExecTool(name, args, staged) {
  if (name === 'read_docx') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const { default: mammoth } = await import('mammoth');
      const result = await mammoth.extractRawText({ path: abs });
      const text = result.value || '';
      return text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text || '(empty document)';
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'read_pdf') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const { createRequire } = await import('module');
      const req = createRequire(import.meta.url);
      const pdfParse = req('pdf-parse');
      const buf = fs.readFileSync(abs);
      const data = await pdfParse(buf);
      const text = data.text || '';
      return text.length > 8000 ? text.slice(0, 8000) + '\n...[truncated]' : text || '(empty PDF)';
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'read_xlsx') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const { default: XLSX } = await import('xlsx');
      const wb = XLSX.readFile(abs);
      const sheetName = args.sheet || wb.SheetNames[0];
      const ws = wb.Sheets[sheetName];
      if (!ws) return `ERROR: Sheet "${sheetName}" not found. Available: ${wb.SheetNames.join(', ')}`;
      const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });
      const preview = JSON.stringify(rows.slice(0, 50), null, 2);
      return `Sheet: ${sheetName} (${rows.length} rows)\n${preview}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'write_xlsx') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    const sheets = Array.isArray(args.sheets) ? args.sheets : [];
    if (!sheets.length) return 'ERROR: sheets array required';
    try {
      const { default: XLSX } = await import('xlsx');
      const wb = XLSX.utils.book_new();
      for (const s of sheets) {
        const headers = Array.isArray(s.headers) ? s.headers : [];
        const rows = Array.isArray(s.rows) ? s.rows : [];
        const wsData = headers.length ? [headers, ...rows] : rows;
        const ws = XLSX.utils.aoa_to_sheet(wsData);
        XLSX.utils.book_append_sheet(wb, ws, String(s.name || 'Sheet1').slice(0, 31));
      }
      XLSX.writeFile(wb, abs);
      staged.files.push({ path: abs, content: `[binary xlsx: ${sheets.length} sheet(s)]` });
      return `CREATED ${abs} with ${sheets.length} sheet(s): ${sheets.map(s => s.name).join(', ')}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'write_csv') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    const headers = Array.isArray(args.headers) ? args.headers : [];
    const rows = Array.isArray(args.rows) ? args.rows : [];
    try {
      const escape = (v) => { const s = String(v ?? ''); return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s; };
      const lines = [];
      if (headers.length) lines.push(headers.map(escape).join(','));
      for (const row of rows) lines.push((Array.isArray(row) ? row : Object.values(row)).map(escape).join(','));
      const csv = lines.join('\n');
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, csv, 'utf8');
      staged.files.push({ path: abs, content: csv });
      return `CREATED ${abs} (${lines.length} rows, ${csv.length} chars). Staged for APPLY.`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'read_csv') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const lines = text.split(/\r?\n/).filter(l => l.trim());
      const preview = lines.slice(0, 50).join('\n');
      return `${lines.length} rows\n${preview}${lines.length > 50 ? '\n...[truncated]' : ''}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  function getEmailConfig() {
    const imapHost = process.env.EMAIL_IMAP_HOST;
    const imapPort = Number(process.env.EMAIL_IMAP_PORT || 993);
    const imapUser = process.env.EMAIL_IMAP_USER;
    const imapPass = process.env.EMAIL_IMAP_PASS;
    const smtpHost = process.env.EMAIL_SMTP_HOST || imapHost?.replace('imap.', 'smtp.');
    const smtpPort = Number(process.env.EMAIL_SMTP_PORT || 587);
    const smtpUser = process.env.EMAIL_SMTP_USER || imapUser;
    const smtpPass = process.env.EMAIL_SMTP_PASS || imapPass;
    return { imapHost, imapPort, imapUser, imapPass, smtpHost, smtpPort, smtpUser, smtpPass };
  }

  if (name === 'list_emails') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured. Add EMAIL_IMAP_HOST, EMAIL_IMAP_USER, EMAIL_IMAP_PASS to .env';
    const mailbox = String(args.mailbox || 'INBOX');
    const limit = Math.min(Number(args.limit || 20), 50);
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock(mailbox);
      try {
        const msgs = [];
        for await (const msg of client.fetch({ seq: `${Math.max(1, client.mailbox.exists - limit + 1)}:*` }, { envelope: true, uid: true })) {
          msgs.push({ uid: msg.uid, seq: msg.seq, subject: msg.envelope.subject || '(no subject)', from: msg.envelope.from?.[0]?.address || '', date: msg.envelope.date?.toISOString() || '' });
        }
        return JSON.stringify(msgs.reverse(), null, 2);
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'read_email') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const uid = String(args.uid || '');
    if (!uid) return 'ERROR: uid required';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const msg = await client.fetchOne(uid, { envelope: true, bodyStructure: true, source: true }, { uid: true });
        if (!msg) return `ERROR: Message UID ${uid} not found`;
        const src = msg.source?.toString('utf8') || '';
        const stripped = src.replace(/Content-Transfer-Encoding: base64[\s\S]*?(?=--|\z)/gi, '[attachment]\n').slice(0, 6000);
        return `From: ${msg.envelope.from?.[0]?.address}\nSubject: ${msg.envelope.subject}\nDate: ${msg.envelope.date}\n\n${stripped}`;
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'search_emails') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const query = String(args.query || '').trim();
    if (!query) return 'ERROR: query required';
    const limit = Math.min(Number(args.limit || 10), 30);
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        const uids = await client.search({ or: [{ subject: query }, { from: query }, { body: query }] }, { uid: true });
        const slice = uids.slice(-limit);
        const msgs = [];
        for await (const msg of client.fetch(slice.join(','), { envelope: true, uid: true }, { uid: true })) {
          msgs.push({ uid: msg.uid, subject: msg.envelope.subject || '(no subject)', from: msg.envelope.from?.[0]?.address || '', date: msg.envelope.date?.toISOString() || '' });
        }
        return `Found ${uids.length} messages (showing ${msgs.length}):\n${JSON.stringify(msgs.reverse(), null, 2)}`;
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'send_email') {
    const cfg = getEmailConfig();
    if (!cfg.smtpHost || !cfg.smtpUser || !cfg.smtpPass) return 'ERROR: Email not configured. Add EMAIL_SMTP_HOST, EMAIL_SMTP_USER, EMAIL_SMTP_PASS to .env';
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '').trim();
    if (!to || !subject || !body) return 'ERROR: to, subject, and body are required';
    try {
      const { default: nodemailer } = await import('nodemailer');
      const transporter = nodemailer.createTransport({ host: cfg.smtpHost, port: cfg.smtpPort, secure: cfg.smtpPort === 465, auth: { user: cfg.smtpUser, pass: cfg.smtpPass } });
      const info = await transporter.sendMail({ from: cfg.smtpUser, to, cc: args.cc || undefined, subject, text: body });
      return `Email sent. Message ID: ${info.messageId}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'create_draft') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const to = String(args.to || '').trim();
    const subject = String(args.subject || '').trim();
    const body = String(args.body || '').trim();
    if (!to || !subject) return 'ERROR: to and subject are required';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const raw = `From: ${cfg.imapUser}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain\r\n\r\n${body}`;
      await client.append('Drafts', Buffer.from(raw), ['\\Draft']);
      await client.logout();
      return `Draft saved to Drafts folder: "${subject}" → ${to}`;
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'label_email') {
    const cfg = getEmailConfig();
    if (!cfg.imapHost || !cfg.imapUser || !cfg.imapPass) return 'ERROR: Email not configured.';
    const uid = String(args.uid || '');
    const label = String(args.label || '').trim();
    if (!uid || !label) return 'ERROR: uid and label required';
    try {
      const { ImapFlow } = await import('imapflow');
      const client = new ImapFlow({ host: cfg.imapHost, port: cfg.imapPort, secure: cfg.imapPort === 993, auth: { user: cfg.imapUser, pass: cfg.imapPass }, logger: false });
      await client.connect();
      const lock = await client.getMailboxLock('INBOX');
      try {
        await client.messageMove(uid, label, { uid: true });
        return `Moved message UID ${uid} to ${label}`;
      } catch {
        await client.messageFlagsAdd(uid, [`\\${label}`], { uid: true });
        return `Applied label "${label}" to message UID ${uid}`;
      } finally { lock.release(); await client.logout(); }
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'move_file') {
    const src = resolveSafePath(args.from);
    const dest = resolveSafePath(args.to);
    if (!src) return 'ERROR: source path not allowed';
    if (!dest) return 'ERROR: destination path not allowed';
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.renameSync(src, dest); return `Moved ${src} → ${dest}`; }
    catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'copy_file') {
    const src = resolveSafePath(args.from);
    const dest = resolveSafePath(args.to);
    if (!src) return 'ERROR: source path not allowed';
    if (!dest) return 'ERROR: destination path not allowed';
    try { fs.mkdirSync(path.dirname(dest), { recursive: true }); fs.copyFileSync(src, dest); return `Copied ${src} → ${dest}`; }
    catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'delete_file') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    staged.files.push({ path: abs, content: '__DELETE__' });
    return `DELETE staged for ${abs}. This will be executed when user clicks APPLY.`;
  }

  if (name === 'analyze_image') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    if (!anthropicApiKey) return 'ERROR: ANTHROPIC_API_KEY not configured';
    try {
      const imgBuf = fs.readFileSync(abs);
      const base64 = imgBuf.toString('base64');
      const ext = path.extname(abs).toLowerCase().replace('.', '');
      const mimeMap = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp' };
      const mediaType = mimeMap[ext] || 'image/jpeg';
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': anthropicApiKey, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: anthropicModel,
          max_tokens: 1024,
          messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }, { type: 'text', text: 'Describe this image in detail.' }] }]
        })
      });
      if (!r.ok) return `ERROR: Vision API ${r.status}`;
      const payload = await r.json();
      return payload.content?.[0]?.text || '(no description)';
    } catch (err) { return `ERROR: ${err.message}`; }
  }

  if (name === 'create_agent') {
    const abs = resolveSafePath(args.path);
    if (!abs) return 'ERROR: path not allowed';
    const content = String(args.content || '').trim();
    if (!content) return 'ERROR: content required';
    staged.files.push({ path: abs, content });
    return `STAGED agent definition at ${abs}. Click APPLY to write it to disk.`;
  }

  if (name === 'create_skill') {
    const abs = resolveSafePath(args.path || path.join(skillsPath, 'new-skill.md'));
    if (!abs) return 'ERROR: path not allowed';
    const content = String(args.content || '').trim();
    if (!content) return 'ERROR: content required';
    staged.files.push({ path: abs, content });
    return `STAGED skill at ${abs}. Click APPLY to install it into the skills library.`;
  }

  if (name === 'deploy_pm2') {
    const script = String(args.script || '').trim();
    const pmName = String(args.name || '').trim();
    const cwd = String(args.cwd || path.dirname(script)).trim();
    if (!script || !pmName) return 'ERROR: script and name required';
    const ecosystemPath = path.join(cwd, 'ecosystem.config.cjs');
    let ecosystem = { apps: [] };
    try { ecosystem = JSON.parse(fs.readFileSync(ecosystemPath, 'utf8')); } catch {}
    ecosystem.apps = ecosystem.apps.filter(a => a.name !== pmName);
    ecosystem.apps.push({ name: pmName, script, cwd, autorestart: true, max_restarts: 5, env: { NODE_ENV: 'production' } });
    const content = `module.exports = ${JSON.stringify(ecosystem, null, 2)};`;
    staged.files.push({ path: ecosystemPath, content });
    return `STAGED PM2 entry "${pmName}" in ${ecosystemPath}. Click APPLY then run: pm2 start ecosystem.config.cjs --only ${pmName}`;
  }

  return runExecTool(name, args, staged);
}
