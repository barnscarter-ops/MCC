import fs from 'node:fs';
import { dataDir, ledgerFile } from '../config.mjs';

export const orchestratorState = {
  updatedAt: null,
  runs: []
};

export function ensureDataDir() {
  fs.mkdirSync(dataDir, { recursive: true });
}

export function readLedger() {
  try {
    ensureDataDir();
    if (!fs.existsSync(ledgerFile)) return [];
    const parsed = JSON.parse(fs.readFileSync(ledgerFile, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    console.error(`Failed to read task ledger: ${error.message}`);
    return [];
  }
}

export function writeLedger(runs) {
  ensureDataDir();
  fs.writeFileSync(ledgerFile, JSON.stringify(runs.slice(0, 100), null, 2));
}

export function addLedgerRun(run) {
  const runs = [run, ...readLedger().filter((item) => item.id !== run.id)].slice(0, 100);
  writeLedger(runs);
  orchestratorState.updatedAt = run.updatedAt || run.finishedAt || run.startedAt || new Date().toISOString();
  return run;
}

export function updateLedgerRun(id, patch) {
  const runs = readLedger();
  const index = runs.findIndex((run) => run.id === id);
  if (index === -1) return null;
  const updated = { ...runs[index], ...patch, updatedAt: new Date().toISOString() };
  runs[index] = updated;
  writeLedger(runs);
  orchestratorState.updatedAt = updated.updatedAt;
  return updated;
}
