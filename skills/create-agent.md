# Skill: Create Maverick Agent

## Trigger
When the user asks to create, build, or make an agent, automation, watcher, or scheduled task.

## Procedure
1. If purpose, trigger, or target folder is unclear — use `{"clarify": "..."}` before proceeding.
2. Determine the target folder. If the user attached a folder chip, use that path. Otherwise ask with clarify.
3. Propose the complete agent .md using `{"done": true, "answer": "..."}`. Include the full file content in a markdown code block. Ask: "Should I create this at [path]? Reply yes to proceed."
4. When the user confirms — issue a single write_file task to Qwen with the exact .md content and exact absolute path.

## Agent .md Format
```
# Agent: [Descriptive Name]

## Purpose
[One sentence — what this agent does and why it exists]

## Trigger
[When it runs — "Manual", "Scheduled daily at 9am", "Event: new file in Downloads folder"]

## Instructions
1. [First action]
2. [Second action]
3. [Continue as needed — be specific about file paths, APIs, conditions]

## Tools
[list_dir / read_file / run_command / Gmail API / Puppeteer / PowerShell / etc.]

## Output
[What it produces — "Slack notification", "Email sent", "File written to X", "Log entry"]
```

## Notes
- File naming: kebab-case, no spaces. E.g.: monitor-invoices.md, voicemail-check.md
- Always confirm the folder path with the user before writing
- The .md is a definition file — it describes what the agent does, not executable code
- If the user wants runnable code too, that is a separate task after the .md is created
