# Skill: Deploy PM2 Service

## Trigger
When the user asks to deploy, register, add, or run a script/agent as a background service, or says "add this to PM2."

## Procedure
1. Read `ecosystem.config.cjs` to see existing services and understand the current format.
2. Clarify anything missing before writing:
   - What is the script path? (absolute path required)
   - What should the service be named? (kebab-case, e.g. `invoice-monitor`)
   - Does it need env vars? If so, from a `.env` file or inline?
   - Python or Node? If Python, is there a `.venv`?
3. Propose the new service entry using `done+answer`. Show the full entry block and the updated `apps` array position. Ask for confirmation before writing.
4. When confirmed — write_file the complete updated `ecosystem.config.cjs` via Qwen.
5. Run the deploy command: `pm2 startOrRestart ecosystem.config.cjs --only <name>`
6. Run `pm2 list` to verify the service shows `online`.
7. If status is `errored` or restart count climbs — run `pm2 logs <name> --lines 30` and report the error.

## ecosystem.config.cjs Entry Format

### Node.js service (.js / .mjs):
```javascript
{
  name: 'service-name',
  script: 'C:\\absolute\\path\\to\\script.mjs',
  cwd: 'C:\\absolute\\path\\to\\project',
  interpreter: 'node',
  watch: false,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  env: {
    NODE_ENV: 'production',
    MY_VAR: 'value',
  },
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
},
```

### Node.js with separate .env file:
```javascript
{
  name: 'service-name',
  script: 'C:\\absolute\\path\\to\\script.mjs',
  cwd: 'C:\\absolute\\path\\to\\project',
  interpreter: 'node',
  watch: false,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 3000,
  env_file: 'C:\\absolute\\path\\to\\.env',
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
},
```

### Python service (use pythonw.exe to suppress console window):
```javascript
{
  name: 'service-name',
  script: 'C:\\absolute\\path\\to\\script.py',
  interpreter: 'C:\\absolute\\path\\to\\.venv\\Scripts\\pythonw.exe',
  cwd: 'C:\\absolute\\path\\to\\project',
  watch: false,
  autorestart: true,
  max_restarts: 10,
  restart_delay: 5000,
  log_date_format: 'YYYY-MM-DD HH:mm:ss',
},
```

## Output
- Updated `ecosystem.config.cjs` with the new service in the `apps` array
- Service running and confirmed `online` via `pm2 list`

## Notes
- Always use absolute paths — relative paths break when PM2 restarts from a different working directory
- The `env` block in ecosystem.config.cjs reads vars from the shell at config-load time via `process.env.*` — requires `require('dotenv').config(...)` at the top of the file (already present in MCC's ecosystem.config.cjs)
- Never use `pm2 restart --update-env` — it reads the current shell env, not the .env file. Always use `pm2 startOrRestart ecosystem.config.cjs`
- `pythonw.exe` = no console window (background service). Use `python.exe` only if you need to see stdout during debugging
- If no `.venv` exists for a Python service, clarify with the user before proceeding
- `max_restarts: 5` for critical services (mav-console), `max_restarts: 10` for agents/watchers
- After deploying, always verify with `pm2 list` — never assume success
