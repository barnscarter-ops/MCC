// BUILD-pipeline routes: apply a staged run (copy staged files onto disk with backups,
// run any staged PM2 commands) and list a directory for the file-picker UI.
import fs from 'node:fs';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { sendJson, readJsonBody } from '../lib/http.mjs';
import { resolveSafePath, stagingSlug } from '../lib/exec.mjs';
import { stagingRoot, backupRoot } from '../lib/config.mjs';

export async function applyStagedRun(req, res) {
  try {
    const { id } = await readJsonBody(req);
    if (!/^stage-[\w-]+$/.test(id || '')) {
      sendJson(res, 400, { error: 'Valid stage id is required.' });
      return;
    }
    const dir = path.join(stagingRoot, id);
    const manifestFile = path.join(dir, 'manifest.json');
    if (!fs.existsSync(manifestFile)) {
      sendJson(res, 404, { error: 'Staged run not found.' });
      return;
    }
    const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (manifest.appliedAt) {
      sendJson(res, 409, { error: `Already applied at ${manifest.appliedAt}.` });
      return;
    }
    const backupDir = path.join(backupRoot, id);
    const applied = [];
    const deleted = [];
    for (const f of manifest.files) {
      // f.path is an absolute path stored by runExecTool write_file
      const dest = resolveSafePath(f.path);
      if (!dest) continue;
      const slug = stagingSlug(f.path);
      const src = path.join(dir, 'files', slug);
      if (!fs.existsSync(src)) continue;
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, slug);
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dest, bak);
      }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(src, dest);
      applied.push(dest);
    }
    // Handle staged deletions
    for (const p of (manifest.deletions || [])) {
      const dest = resolveSafePath(p);
      if (!dest) continue;
      if (fs.existsSync(dest)) {
        const bak = path.join(backupDir, stagingSlug(p));
        fs.mkdirSync(path.dirname(bak), { recursive: true });
        fs.copyFileSync(dest, bak);
        fs.unlinkSync(dest);
        deleted.push(dest);
      }
    }
    // Run any PM2 commands that were staged alongside the files
    const pm2Results = [];
    for (const cmd of (manifest.pm2Commands || [])) {
      try {
        execSync(`pm2 start "${cmd.ecosystemPath}" --only "${cmd.name}"`, { encoding: 'utf8', timeout: 15_000 });
        pm2Results.push({ name: cmd.name, status: 'started' });
      } catch (pm2Err) {
        // Restart if already registered
        try {
          execSync(`pm2 restart "${cmd.name}"`, { encoding: 'utf8', timeout: 10_000 });
          pm2Results.push({ name: cmd.name, status: 'restarted' });
        } catch (restartErr) {
          pm2Results.push({ name: cmd.name, status: 'error', error: restartErr.message });
        }
      }
    }
    manifest.appliedAt = new Date().toISOString();
    fs.writeFileSync(manifestFile, JSON.stringify(manifest, null, 2));
    sendJson(res, 200, { ok: true, applied, deleted, backupDir, pm2Results });
  } catch (error) {
    sendJson(res, 500, { error: error.message });
  }
}

export function handleListDirs(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const reqPath = url.searchParams.get('path') || 'C:\\';
  // Normalize bare drive letters: 'C:' → 'C:\' so path.resolve returns the root, not process CWD
  const normalized = /^[A-Za-z]:$/.test(reqPath.trim()) ? reqPath.trim() + '\\' : reqPath;
  const abs = path.resolve(normalized);
  let dirs = [], files = [];
  try {
    const all = fs.readdirSync(abs, { withFileTypes: true });
    for (const e of all) {
      if (e.name.startsWith('.')) continue;
      if (e.isDirectory()) dirs.push(e.name);
      else files.push(e.name);
    }
    dirs.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    files.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  } catch { /* unreadable — return empty */ }
  sendJson(res, 200, { path: abs, dirs, files });
}
