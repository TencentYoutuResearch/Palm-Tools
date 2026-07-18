---
schema_version: 2
id: specops-agent-orchestration
kind: spec
document_class: normative
spec_type: architecture
title: SpecOps multi-agent orchestration
status: active
paths:
  - apps/specops/src/domain/agent-prompts.ts
  - apps/specops/src/domain/run-loop.ts
  - apps/specops/src/domain/session.ts
  - apps/specops/frontend/src/components/chat/AgentCoordinationGraph.svelte
verifies:
  - specops-test
---

# SpecOps multi-agent orchestration

## Roles

SpecOps exposes three user-recognizable roles. A role selection is resolved when an agent or Run is created so later configuration edits do not mutate active execution.

- **Clarify / Plan** is the primary agent. It discusses the feature with the user, records decisions, decomposes modules and acceptance criteria, issues implementation contracts, and evaluates the final review verdict.
- **Implementation** refines an approved contract into executable tasks, changes only the isolated Run worktree, verifies its work, and produces an evidence handoff. It never applies or merges its own result.
- **Review** is an independent read-only agent. It checks the implementation against the plan, specs, constitution, diff, and verification evidence, then returns a structured verdict to Clarify / Plan.

## Control loop

```text
user <-> Clarify / Plan --task contract--> Implementation
             ^                                 |
             |                                 | evidence handoff
             |                                 v
             +---------- review verdict ------ Review
             |
             +-- incomplete --> focused repair contract --> Implementation
```

Critical findings return the same Run to Implementation within the iteration budget. Clarify / Plan closes the module only after review evidence covers the approved acceptance criteria. Exhausted budgets require human action.

Review may recommend `ready to apply`, but cannot merge to the main workspace. The existing human review and explicit apply gate remain authoritative, preserving Run isolation.

## Configuration and prompts

Workspace agent selections live in `specops.toml`:

```toml
[agents.analysis]
backend = "codebuddy"
model = "claude-sonnet"
avatar = "gallery/fox"
prompt_file = ".specops/agents/clarify.md"

[agents.implementation]
backend = "codex"
model = "gpt-5-codex"
avatar = "gallery/robot"
prompt_file = ".specops/agents/implementation.md"

[agents.review]
backend = "claude"
model = "claude-opus"
avatar = "gallery/owl"
prompt_file = ".specops/agents/review.md"
```

`agents.analysis` remains the compatibility name for the Clarify / Plan role. Backend, model, avatar, and prompt file inherit from `agents.default` when omitted. An omitted avatar follows the effective backend. Prompt paths must remain inside the Git workspace.

`specops init` creates editable prompt files under `.specops/agents/` without overwriting existing files. Packaged defaults remain embedded in the sidecar as a fallback for older workspaces. Implementation and review prompt text is snapshotted into `run.json`; resume and repair therefore use the same role contract that started the Run.

## Observation contract

The session Execution panel renders one integrated relay map from durable workflow phase and agent history. A Request entry feeds the fixed Clarify → Implementation → Review stations; workflow steps live inside their owning role nodes instead of appearing in a second progress list. Apply and Done remain explicit delivery gates. Each role uses its configured kode gallery avatar with state-specific frames and falls back to its backend icon, shows state, and can expand its effective backend/model/session details. The map includes an explicit Review → Clarify verdict rail and repair-loop count. Status uses stable color and borders; only the connector carrying an active handoff may animate, and reduced-motion preferences disable that movement.
