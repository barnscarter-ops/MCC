// Centralized configuration: environment-derived constants and shared paths.
// Env is populated by PM2 (ecosystem.config.cjs loads dotenv) before this module loads.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// rootDir is the project root (this file lives in ./lib).
export const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const distDir = path.join(rootDir, 'dist');
export const port = Number(process.env.PORT || 3011);
export const deployStartedAt = new Date().toISOString();
export const prometheusUrl = process.env.PROMETHEUS_URL || 'http://192.168.1.12:9090';
export const ragUrl = process.env.MAV_RAG_URL || 'http://192.168.1.12:8181';
export const llamaServerUrl = process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080';
export const localModel = process.env.LOCAL_MODEL || 'qwen3-14b';
export const piExecutable = process.env.PI_EXECUTABLE || 'pi';
export const piModel = process.env.PI_MODEL || 'qwen3-14b';
export const repoBridgeUrl = process.env.MAV_REPO_BRIDGE_URL || '';
export const geminiApiKey = process.env.GEMINI_API_KEY || '';
export const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
export const GEMINI_MODES = new Set(['review']); // Gemini = everyday chat only (REVIEW mode)
export const openAiApiKey = process.env.OPENAI_API_KEY || '';
export const openAiBaseUrl = process.env.OPENAI_BASE_URL || 'https://api.openai.com';
export const nimApiKey = process.env.NVIDIA_NIM_API_KEY || '';
// qwen2.5-coder-32b retired (410), qwen3.5-122b-a10b too slow (60s timeout) — llama-3.3-70b for main tasks
export const nimModel = process.env.NIM_MODEL || 'meta/llama-3.3-70b-instruct';
// QC uses a fast 8B model — "SHIP or HOLD" doesn't need a 70B model
export const nimQcModel = process.env.NIM_QC_MODEL || 'meta/llama-3.1-8b-instruct';
export const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
export const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
// Brave Search — free tier 2k queries/month: brave.com/search/api/
// TODO: Add BRAVE_SEARCH_API_KEY to .env once you get the key
export const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || '';
export const dataDir = process.env.MAV_CONSOLE_DATA_DIR || path.join(rootDir, '.mav-console');
export const ledgerFile = path.join(dataDir, 'task-runs.json');
export const seoTaskLogFile = path.join(dataDir, 'seo-task-log.json');
export const orchestratorStateFile = path.join(dataDir, 'orchestrator-state.json');
export const workspacePath = process.env.MAV_CONSOLE_WORKSPACE || rootDir;
export const memoryPath = process.env.MAV_MEMORY_PATH || 'C:\\Users\\carte\\.claude\\projects\\memory';
export const skillsPath = process.env.MAV_SKILLS_PATH || path.join(rootDir, 'skills');
export const hcpDir = process.env.HCP_PROJECT_DIR || 'C:\\Users\\carte\\Grizzly-HCP';
export const stagingRoot = path.join(rootDir, 'tmp', 'build-staging');
export const backupRoot = path.join(rootDir, 'tmp', 'build-backup');

// Blocked system and sensitive paths — everything else is accessible.
// MAV_EXTRA_ROOTS is kept for backward compat but no longer needed for access control.
export const BLOCKED_ABS_RE = /[/\\](\.env$|\.git[/\\]|Windows[/\\]|Program Files[/\\]?|AppData[/\\]Local[/\\]Temp|System32[/\\]|SysWOW64[/\\]|WindowsApps[/\\])/i;
export const BLOCKED_REL = /^(\.env$|\.git(\/|$)|node_modules(\/|$)|package-lock\.json$|tmp(\/|$)|\.mav-console(\/|$))/i;

export const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg'
};

export const ALLOWED_ORIGINS = [
  'https://homelab-noc-dashboard.vercel.app',
  'https://carterspc.tailf72e3f.ts.net',
  'http://localhost:5173',
  'http://localhost:5174',  // maverick-assistant dev
  'http://localhost:3011',
  'http://localhost:3012',  // maverick-assistant prod
];
