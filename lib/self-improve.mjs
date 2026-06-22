// Fire-and-forget trigger for the background Qwen self-improvement pass. Shared by the
// chat-failure recorder (server.mjs) and the orchestrator task-run handlers, so it lives
// in lib/ to avoid a circular dependency between those two.
import path from 'node:path';
import { spawn } from 'node:child_process';
import { rootDir, memoryPath } from './config.mjs';

export function triggerSelfImprove() {
  const scriptPath = path.join(rootDir, 'scripts', 'qwen-self-improve.mjs');
  const child = spawn(process.execPath, [scriptPath], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, MAV_MEMORY_PATH: memoryPath }
  });
  child.unref();
  console.log('[self-improve] triggered in background');
}
