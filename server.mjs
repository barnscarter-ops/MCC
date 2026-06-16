import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.join(__dirname, 'dist');
const port = Number(process.env.PORT || 3011);
const deployStartedAt = new Date().toISOString();
const prometheusUrl = process.env.PROMETHEUS_URL || 'http://192.168.1.12:9090';
const ragUrl = process.env.MAV_RAG_URL || 'http://192.168.1.12:8181';
const llamaServerUrl = process.env.LLAMA_SERVER_URL || 'http://127.0.0.1:8080';
const localModel = process.env.LOCAL_MODEL || 'qwen3-14b';
const repoBridgeUrl = process.env.MAV_REPO_BRIDGE_URL || '';
const geminiApiKey = process.env.GEMINI_API_KEY || '';
const geminiModel = process.env.GEMINI_MODEL || 'gemini-2.0-flash';
const GEMINI_MODES = new Set(['review']); // Gemini = everyday chat only (REVIEW mode)
const openAiApiKey = process.env.OPENAI_API_KEY || '';
const nimApiKey = process.env.NVIDIA_NIM_API_KEY || '';
// qwen2.5-coder-32b retired (410), qwen3.5-122b-a10b too slow (60s timeout) — llama-3.3-70b for main tasks
const nimModel = process.env.NIM_MODEL || 'meta/llama-3.3-70b-instruct';
// QC uses a fast 8B model — "SHIP or HOLD" doesn't need a 70B model
const nimQcModel = process.env.NIM_QC_MODEL || 'meta/llama-3.1-8b-instruct';
const anthropicApiKey = process.env.ANTHROPIC_API_KEY || '';
const anthropicModel = process.env.ANTHROPIC_MODEL || 'claude-haiku-4-5-20251001';
// Brave Search — free tier 2k queries/month: brave.com/search/api/
// TODO: Add BRAVE_SEARCH_API_KEY to .env once you get the key
const braveApiKey = process.env.BRAVE_SEARCH_API_KEY || '';
const dataDir = process.env.MAV_CONSOLE_DATA_DIR || path.join(__dirname, '.mav-console');
const ledgerFile = path.join(dataDir, 'task-runs.json');
const workspacePath = process.env.MAV_CONSOLE_WORKSPACE || __dirname;
const memoryPath = process.env.MAV_MEMORY_PATH || 'C:\\Users\\carte\\.claude\\projects\\memory';
const skillsPath = process.env.MAV_SKILLS_PATH || path.join(__dirname, 'skills');