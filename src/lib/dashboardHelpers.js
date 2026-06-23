// Pure-JS dashboard helpers extracted from main.jsx: network-rate formatting,
// model-name display, file-attach constants + reader, and localStorage job history.
import { formatMbps } from './format.js';

export function formatFullRate(mbps) {
  if (!Number.isFinite(mbps)) return 'WAITING';
  if (mbps >= 1000) return `${(mbps / 1000).toFixed(2)} Gb/s`;
  if (mbps >= 10) return `${mbps.toFixed(0)} Mb/s`;
  if (mbps > 0) return `${mbps.toFixed(1)} Mb/s`;
  return '0 Mb/s';
}

export function formatWanDown(metrics) {
  const portDown = Number(metrics.switchPort24Rx);
  if (Number.isFinite(portDown) && portDown > 0) return formatFullRate(portDown);
  const wanDown = Number(metrics.wanDown);
  if (Number.isFinite(wanDown)) return formatFullRate(wanDown * 1000);
  return 'WAITING';
}

export function formatPcUpDown(metrics) {
  const down = Number.isFinite(metrics.switchPort3Rx) ? metrics.switchPort3Rx : metrics.pcNetIn;
  const up = Number.isFinite(metrics.switchPort3Tx) ? metrics.switchPort3Tx : metrics.pcNetOut;
  return `D ${formatMbps(down)} / U ${formatMbps(up)}`;
}

export function compactModelName(name) {
  if (!name) return 'NO MODEL';
  return name.replace(/^qwen/i, 'Qwen').replace(/-/g, ' ');
}

export function workerLabel(workerId) {
  const labels = {
    'local-qwen': 'LOCAL QWEN',
    'repo-bridge': 'REPO BRIDGE',
    'codex-review': 'CODEX REVIEW',
    'claude-cli': 'CLAUDE CLI',
    'rag-server': 'RAG SERVER'
  };
  return labels[workerId] || workerId?.toUpperCase?.() || 'UNROUTED';
}

export const ATTACH_IGNORE = new Set(['node_modules', '.git', 'dist', '.venv', '__pycache__', '.cache', 'build', '.next', 'tmp']);
export const ATTACH_EXTS = new Set(['.mjs', '.js', '.jsx', '.ts', '.tsx', '.py', '.css', '.json', '.cjs', '.md', '.sh', '.ps1', '.yaml', '.yml']);
export const IMAGE_EXTS = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp']);
export const MAX_FILE_BYTES = 8000;
export const MAX_TOTAL_BYTES = 32000;

export async function readFileText(file) {
  const ext = file.name.split('.').pop()?.toLowerCase() || '';
  if (IMAGE_EXTS.has(ext) || file.type.startsWith('image/')) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const dataUrl = e.target.result || '';
        const base64 = dataUrl.split(',')[1] || '';
        resolve({ __image: true, data: base64, mimeType: file.type || `image/${ext}` });
      };
      reader.onerror = () => resolve('[unreadable]');
      reader.readAsDataURL(file);
    });
  }
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = e => resolve(e.target.result || '');
    reader.onerror = () => resolve('[unreadable]');
    reader.readAsText(file);
  });
}

// ── Job history helpers ───────────────────────────────────────────────────────
export const MCC_JOB_INDEX_KEY = 'mcc-job-index';
export const mccJobKey = id => 'mcc-job-' + id;
export function mccLoadJobIndex() {
  try { return JSON.parse(localStorage.getItem(MCC_JOB_INDEX_KEY) || '[]'); } catch { return []; }
}
export function mccSaveJob(label, history) {
  if (!history.length) return;
  const id = Date.now().toString(36);
  const index = mccLoadJobIndex();
  index.unshift({ id, label, ts: Date.now() });
  try { localStorage.setItem(MCC_JOB_INDEX_KEY, JSON.stringify(index.slice(0, 20))); } catch {}
  try { localStorage.setItem(mccJobKey(id), JSON.stringify(history)); } catch {}
}
export function mccLoadJob(id) {
  try { return JSON.parse(localStorage.getItem(mccJobKey(id)) || '[]'); } catch { return []; }
}

export const WORKFLOW_MODES = [
  { id: 'ask',         label: 'ASK MAVERICK',  accent: 'cyan',   tooltip: 'Ask business questions, scope jobs, and build estimates — say "build it" when ready to push to HCP' },
  { id: 'build',       label: 'BUILD / FIX',   accent: 'amber',  tooltip: 'Claude plans, Qwen executes — full filesystem access, build or edit any file on any drive' },
  { id: 'ops',         label: 'OPERATIONS',    accent: 'green',  tooltip: 'Personal assistant — read emails, Word/PDF docs, build spreadsheets, send emails, create agents and skills' },
  { id: 'claude-code', label: 'SUPERPOWERS',   accent: 'purple', tooltip: 'Claude Code CLI — direct file editing, shell commands, full tool use. No staging, no approval gates. Runs autonomously.' },
];
