# CLAUDE.md

@AGENTS.md

## Claude Code specifics

- Subagents live in `.claude/agents/`: `planner`, `test-author`, `reviewer`. Use them as described in the flow above; the main session never acts as its own reviewer.
- `.claude/hooks/agent-guard.mjs` runs on every Write, Edit and Bash call and enforces the subagent roles by `agent_type`. Its tests: `node --test .claude/hooks/agent-guard.test.mjs`. If the guard blocks you, report it; do not look for a way around it.
- `.claude/settings.json` denies reading secret files and running apply, deploy, migration-push and force-push commands, and asks before pushing or editing the guardrail files. A denied command means the step belongs to CI or to the human.
- The builder runs inside the `sbx` sandbox described in `docs/ai-workflow.md`. There are no cloud credentials in it on purpose. A host session runs outside it with the human's credentials; only `.claude/settings.json` and the instructions bound it (see AGENTS.md).
