# First-use onboarding audit — checkpoint 491

Read-only audit during current full-regression source freeze. This is a gap inventory, not an acceptance certificate.

## Confirmed current paths

- BuilderView mounts goal/interview, workspace, selection, account, funding, start/conversation, workflow registration and proposal confirmation components. These cover owner configuration, but their combined zero-state execution still lacks one full desktop test.
- proposeBuilderDefaults uses configured defaults or a unique available official profile/provider/model/workspace. Ambiguous metadata returns needs_configuration. It does not invent a capability assessment or choose an arbitrary model. This is a supported configuration boundary, not proof of conversational setup.
- setupBuilderWorkflow registers immutable workflow/project/delivery versions from the reviewed proposal and preserves exact retry intent. It never registers the executable verification command itself.
- /api/kode/verification/definitions is owner-only. POST takes an explicit complete definition; GET requires exact runner/command/revision and returns the public reference. Registration persists an immutable revision and does not execute. Worker/Builder agents cannot authorize this owner step.
- VerificationRunners already loads durable definitions and checks executable identity at execution. Native pipeline tests explicitly register commands in setup. pipelineBuilder also pre-seeds creation grants/accounts/budgets. Such fixture setup cannot certify first-use onboarding.

## Concrete missing product path

BuilderWorkflowView shows only command references (runner and scenarios); BuilderView has no verification-definition setup component. A new owner cannot review and register the proposed executable/arguments/limits through this IM UI. A workflow proposal may register successfully while activation correctly refuses its unavailable command. This is necessary functionality for zero-state local implementation/review/verification, not just missing test evidence.

## Next implementation after source freeze

1. Add an owner review/register/recover surface for local verification definitions, reusing the existing persistent registry and authority checks. Require explicit executable, argv, scenarios, capabilities, network permission, timeout and output bounds. Registration must not execute or grant permission.
2. Obtain executable identity through a read-only Host preview, tied to exact reviewed input; do not ask an agent to invent executable_hash. Restrict preview to an executable regular file, resolve the actual file, hash safely and recheck identity at confirmation. Do not read environment credentials or expand shell text. Prefer empty env for first-use form; do not expose existing secret values.
3. Preserve exact immutable command identity across lost response/reload; lookup reference before retry. A changed proposal requires a new explicit review. Do not silently overwrite revisions or alter active workflows.
4. Show a registered public reference which the creation assistant can bind into the proposal. Keep local Host identity explicit; remote registry setup needs its own routing acceptance and must not be silently applied locally.
5. Add actual owner-route/registry persistence tests and full desktop review/cancel/register/lost-reply/reload checks. Then combine fresh draft, registered command, reviewed team configuration, activation and user request through delivery with a controlled adapter. No paid provider calls or daily installation.

Other incomplete paths retain their existing scope: actual provider collector/executor coverage, two-team resource pressure, crash reconciliation and AC1–AC13 final audit. UI command registration alone will not close these requirements.

## Implementation update 501–502

The owner preview/register/recover route and React form are now integrated in the isolated worktree; first integrated core/HTTP/storage/form tests pass. The original seven-tool Builder grant contract is preserved: command reference lookup extends its existing catalog tool, rather than requiring a new tool grant. Native Builder compatibility rerun502 is pending. The original missing-UI finding above describes the pre501 state; whole first-use acceptance is still not achieved.
