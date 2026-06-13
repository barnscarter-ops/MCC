# Skill: Create Maverick Skill

## Trigger
When the user asks to create, add, or define a skill, procedure, or playbook for Claude to follow.

## Procedure
1. If the skill's purpose or trigger phrase is unclear — use `{"clarify": "..."}`.
2. Draft the full skill .md and propose it using `{"done": true, "answer": "..."}` with the content in a code block. Ask: "Should I add this skill at skills/[filename].md? Reply yes to proceed."
3. When the user confirms — write_file to the skills/ folder. Qwen writes the exact content, nothing more.

## Skill .md Format
```
# Skill: [Name]

## Trigger
[What the user says or what task type activates this skill]

## Procedure
1. [Exact step — include tool names, paths, naming conventions]
2. [Next step]
...

## Output
[What gets created or changed — file paths, formats, expected end state]

## Notes
[Gotchas, edge cases, things to verify, dependencies]
```

## Notes
- File naming: kebab-case. E.g.: deploy-pm2-service.md, add-api-endpoint.md
- Skills folder is always: the MCC skills/ directory
- A good skill is specific enough that following it mechanically produces the right result
- After writing, remind the user: "This skill will auto-load on future BUILD requests."
