# Current final scope status — 2026-11-05

Separate lifecycle proof: `live-coordinator-idle-accounting.log` and `live-coordinator-idle-result.json` pass two natural idle-close rounds (6 actual decisions, all known usage), each reservation finalized with held=0, unique settlement row, and a second request waking the same team/contact/conversation/session under a new operation/control revision after Hub restart. This is separate evidence; it does not change the Builder 54-call run's pre-cleanup checkpoint of active / held39 / finalizedfalse. Binary restart hash was identical and 631 repository/support/evidence plus 3402 runtime entries had no changes/missing paths. No production fix was needed.


Full Node aggregate `aggregate-work-run-accounting-current.log` exits 0: 1102 total / 1095 pass / 0 fail / 7 skip / 1066551.669292 ms. Its 778-file manifest has changed/missing/added all empty. Project check is Rust 968 pass / 7 ignored, GUI 0 errors / 2 warnings; the 345-file manifest has no changed/missing paths. WorkRun targeted is 28/28 (including, not in addition to, 14 pure validators) and includes the real isolatedHub Worker null-usage path.

Actual Builder-generated-team run passes 22 Builder + 32 team decisions, all with known usage; all three stages, delivery, restart preservation and cleanup passed. Live provenance: 629 manifest entries, only `target/debug/kode-session-server` changed during sampling; other 628 matched. The 3402-entry runtime comparison matched a mid-run snapshot, not startup. The harness does not prove final reserved=0/every reservation finalized: visible checkpoint was Coordinator active / held39 / finalizedfalse before fixture cleanup. A separate actual idle-close/settlement gate now passes; its state is recorded independently below.

Configured-team 31-decision delivery and same-computer OpenSSH 9-scenario evidence remain separate. AC1–AC13 are not declared complete. Page design is deferred; P5.9/P5.10 UI/performance remain unverified, not waived. Current evidence entry points are in `evidence/terminal-stream-20261105/README.md`.

## Historical checkpoints (superseded by current status above)

> 历史记录：该阶段 Node aggregate 为 1056/1063，770 文件快照；close-drain targeted 与 Builder 实跑当时仍在进行。当前终态以本文顶部 Current acceptance status 为准。

### Historical schema aggregate checkpoint

最新源码全量 Node 回归 aggregate-schema-current.log 已以 exit 0 结束：1063 项，1056 通过、0 失败、7 跳过，1173.505 秒。770 文件前后比对无变化、新增或缺失（aggregate-schema-manifest-check.json）。覆盖最新 HTTP 422 修复、完整桌面/历史兼容、已安装原生引擎契约和 tcodex 的受控回答续接；本轮没有真实供应商推理。

7 项跳过详见 aggregate-schema-skips.txt：3 个未启用的已安装 ACP 执行器契约、1 个独立原生插件安装用例、3 个真实供应商推理 opt-in。不能把这些跳过计为通过。真实 hy4 的既有 31 决策全角色交付是独立证据；创建助手完整激活及其生成团队的一条龙真实交付仍待通过。

最新精确项目检查 project-check-builder-schema.log 通过：Rust 967 通过、7 忽略，GUI 0 错误、2 警告。最新真实激活重跑在第 17 个原生决策缺少用量后被 usage_unresolved 门禁停止；当前继续运行用量通知诊断与独立的完整创建到交付案例。尚未证明缺失来自供应商还是原生事件时序，不放宽预算门禁。Goal 保持 active。

The actual free-hy4 Builder failure is now identified as kode_builder_save_draft receiving a non-JSON HTTP422 from TeamSpec JSON extraction. The backend now returns a typed JSON schema diagnostic, and the official save returns a no-effect correction result only for this exact endpoint/status after checking the original receipt. Six outcome-boundary units and three HTTP/official-entry tests pass, including both Builder modes, unchanged draft/no receipt and later valid save. Fresh actual Builder activation and exact project checks are running. The preceding 1038-pass full Node aggregate predates this correction. See evidence/terminal-stream-20261105/builder-schema-checkpoint.md. Goal remains active.

## Current terminal checks — 2026-11-05

Current frozen 769-file Node aggregate passes 1038 tests, zero failures and 19 explicit opt-in skips. Manifest check has zero changed, added or missing files. Released full desktop/history tests are included. Exact project check exits zero with 967 Rust passes, seven ignored, GUI zero errors/two warnings. The actual free-hy4 all-role local delivery passes 31 decisions. Actual full Builder activation still FAILS on a later tool outcome requiring reconciliation; the initial malformed catalog-limit rejection has been repaired and is observed correcting live. Its diagnostic retry is running. This remains required work. Current evidence map and full details are `evidence/terminal-stream-20261105/ac-review-current.md` and `builder-closure-checkpoint.md`. Goal remains active.

## Current checkpoint — 2026-11-05 Builder closure

The fixed-source Node aggregate passed 1036 tests with zero failures and 21 opt-in skips. Current actual free-hy4 all-role delivery passes 31 real decisions. Current production OpenSSH transport/recovery passes nine controlled-model cases on one computer. A subsequent actual Builder proposal run exposed malformed arguments classified as authorization failure. This is corrected with five passing focused tests. Actual Builder activation retry, desktop fixture follow-up, rendered review and final AC1–AC13 acceptance remain open. See `evidence/terminal-stream-20261105/builder-closure-checkpoint.md` for current scope. Earlier dated entries below retain historical findings.

# Final scope audit — implementation still incomplete

### Historical checkpoint before independent idle-close proof

Full Node aggregate `aggregate-work-run-accounting-current.log` exits 0: 1102 total / 1095 pass / 0 fail / 7 skip / 1066551.669292 ms; 778-file manifest changed/missing/added all empty. Project check: Rust 968 pass / 7 ignored, GUI 0 errors / 2 warnings; 345-file manifest has no changed/missing paths. WorkRun targeted is 28/28, including the 14 pure validators and real isolatedHub Worker null-usage path.

Actual Builder-generated-team run passes: 22 Builder + 32 team decisions, all with known usage; all stages, delivery, restart preservation and cleanup passed. Scope limits: the 629-entry live manifest changed only `target/debug/kode-session-server`, while 628 other entries matched; the 3402-entry runtime comparison matched a mid-run snapshot, not startup. The harness did not assert final reserved=0/every reservation finalized; checkpoint was Coordinator active / held39 / finalizedfalse before fixture cleanup. At the time of this checkpoint, an actual idle-close/settlement gate was pending; the separate gate has since passed, as described in the current summary above. AC1–AC13 remain unclaimed as complete, and P5.9/P5.10 UI/performance remain unverified, not waived.

Latest2026-11-05 checkpoint supersedes the historical open native-role statements below. Actual free-hy4 Coordinator plus implementation/review/verification Workers pass a configured local owner request with30native decisions, Home completion, process stop, accounting and restart assertions. Two separate all-live Worker repeats also pass. Unique trusted-tool output recovery passes local/paired-Hub omission tests and33compatibility tests. Builder closure regression passes19tests. See evidence/terminal-stream-20261105/output-recovery-checkpoint.md for precise scopes and limits. Full actual Builder proposal/activation, real SSH Host integration, broader product acceptance and final whole-source gates remain open.

The current full Node run reproduces a native-answer test fixture omission. Its synthetic adapter passed original message history without restoring the engine's separate system instructions, violating the new Worker prompt assertion. Restoring that field in the test fixture passes the installed-engine question/answer recovery test in15.082s. Production code is unchanged by this correction. The full run spans that fixture edit and remains diagnostic. A fixed-source full result is still required.

2026-11-05 actual free-hy4 Builder interview passes4decisions and saves3pending questions, with known usage and1internal test credit. Worker idle without published outputs is diagnosed from a terminal failed real run. Added a scoped versioned Worker output procedure, passing5scope/flow plus21compatibility tests. Automatic missing-output recovery remains open. A new actual Worker repeat is running. See worker-procedure-checkpoint.md.

2026-11-05 actual free-hy4 Builder read passes2real decisions through a normal prepared operation, Home tool reconciliation, known token usage and1internal test-credit charge. Draft unchanged, no team created. This closes only the live read/reply primitive. Live interview/proposal/activation and live Coordinator delivery remain open. Post-live-fixture owned-peer role/default regression passes14with0skips. Evidence live-builder-read.log.

2026-11-05 native normal-entry follow-up passes installed-engine Builder prepared/atomic startup and a17-decision Coordinator/Worker workflow. Owned synthetic Responses supply model decisions. All3workflow stages and real verification pass, with budget and recovery assertions. Native Builder default discovery/current-resource projection are implemented. Real-provider Builder/Coordinator reasoning and real-hy4 Worker stability remain open. See native-role-entry.log.

2026-11-05 native role boundary follow-up passes37actor/transport tests,3installed-engine configuration-only role tests and21owned-Hub selection/guard tests, all0skips. Live Builder/Coordinator remains incomplete. The latest-main low-effort all-live Worker run is now terminal failed at723.662s waiting for workflow completion. Its precise stall remains unproven. See implementation-progress.md and evidence/terminal-stream-20261105.

2026-11-05 latest-main refresh now uses work/super-agent-im-collab-main-20261105 at f8463d8 in a separate cache worktree. Overlay comparison has0missing files/0conflicts, with one expected upstream source difference. Current-code live Worker repeat on the preserved prior baseline fails on a300second reviewer inference timeout, with confirmed process-group stop. The earlier complete live pass remains recorded, while repeated stability remains open. Latest-main frontend build and21unit tests pass; backend and further live acceptance are pending.

2026-11-05 first actual all-live implementation/review/verification Worker delivery passes in537.852s with12real free-hy4 decisions and all3Home stages passed. Coordinator remains controlled. The live run spans a later semantic-validation helper correction, so a current-code repeat is required and is now running. Current focused61passes with0skips, including recovery and preserved grant semantics. See evidence/terminal-stream-20261105/live-all-workers-first-pass.log. This milestone does not close live Coordinator/Builder or whole-product acceptance.

2026-11-05 terminal-SSE follow-up fixes native peer closure after a complete successful response frame. Installed engine text/tool regressions pass2 and extended native/wrapper/Home regressions pass60 with0skips. Actual all-live Workers advance past implementation but independent review still fails on tool-outcome reconciliation. Coordinator inference remains controlled. The old mixed-source aggregate is terminal994pass/4fail/19skip, not an active wait or final source-current gate. Evidence is in evidence/terminal-stream-20261105. Whole-team live delivery and overall acceptance remain open.

2026-11-05 live-Worker milestone now has two consecutive Home workflow passes with4actual free-hy4 implementation decisions each. Coordinator/reviewer/verifier inference remains controlled. Final focused49plus separate question2pass with0skips. Earlier transport failures remain recorded. See evidence/live-home-worker-20261105. Whole-team live inference and full-source aggregate remain open.

2026-11-05 follow-up passes47 source-current focused tests with0skips, including forced schema-error recovery through the real Home workflow and the14-case Assignment child suite. Live Home delivery still has failed enclosing acceptance. The running full aggregate is diagnostic because source changed during it. See evidence/home-argument-recovery-20261105.

Live Host-tool follow-up now has two consecutive real free-hy4 two-decision passes and42 focused tests with0skips. Earlier stream/replay failures are retained. Full live Home WorkRun remains unverified. See evidence/live-wrapper-tools-20261104.

Authenticated wrapper transport follow-up passes40 focused tests with0skips and one real free-hy4 text decision through the production managed actor. Actual full-provider WorkRun acceptance remains open. Evidence is retained in evidence/wrapper-auth-20261104.

Acceptance remains in progress. The latest implementation progress includes configurable
Codex workflow Workers, native question/answer continuation, paired-Hub complete delivery
and recovery, event-driven relay sending, Chrome answer-permission interaction, and an
installed TCodex bootstrap with public model-catalog hashes. The managed-bootstrap focused
gate passes33tests with0skips. Its model output is controlled. Live-hy managed delivery,
physical SSH acceptance, broader product/UI acceptance, latest full dsh aggregate and the
complete AC1-AC13 audit remain open. The dated checkpoints below retain earlier findings.
Current logs and source hashes are recorded in implementation-progress.md and its linked
evidence directories.

This file records current requirement findings. It does not replace proposal AC1–AC13 or tasks P0–P6. Passing a frozen regression snapshot does not close unimplemented requirements. Evidence names below refer to files actually inspected; regression632 emitted839total/835passed/0failed/4skipped and its1105file manifest comparison has no changes/missing/additions. Original exec92216 is now absent. The exact exit code awaits the helper report. Its freeze has ended and contact implementation634–640 follows.

## Confirmed implemented, with remaining whole-source gates

| Requirement | Inspected current evidence | Limit |
|---|---|---|
| AC1: two persistent identities, distinct workspaces/resources, different runtime Session, cancelled draft | `test/paired-contact-rotation.test.js`, `test/fixture-coordinator-pipeline.js`, `test/support/paired-contact-team.js`; actual631 passed | Shipped React in fixture shell; complete desktop Builder flow has separate552/553 evidence. |
| Home-wide shared verification-resource exclusion | `assignment_exclusive_resources.rs`, schema29 migration, Host admission and owner command review;611/612/614 passed | Remote named-resource pipeline and both cancellation scenarios passed in632. Cooperative registered commands, not arbitrary process sandboxing. |
| Fresh successor custody and publication | Exact predecessor/activation gates, immutable intake consumption, own consumed update required;624/625/627/630/631 passed | Automatic default recovery still prefers same Session; fresh runtime is a controlled successor, never an input replay. |
| Full process trace and archived required delivery evidence | `work_run_trace.rs`, `home-trace.js`, twelve-stream browser export;574–589 evidence | Raw tool payloads remain execution-session-only; metadata hashes are retained at Home. Current aggregate still required. |

## Contact follow-up implemented, final whole-source gates pending

Home now persists owner pin/archive preferences and exact request receipts independently from team configuration. A bounded contact-directory query ranks all contacts by pin, decision/resource/stop attention, unread and recent activity before keyset pagination. Query-scoped opaque cursors reject search/archive-filter changes. In-flight work and post-archive new messages keep a contact visible in the main list. The UI exposes archive navigation, attention labels, pin/unpin, archive/unarchive and persistent lost-response recovery. New code resides in contact_directory.rs, contact-directory-route.js and the collab contact-preference modules.

Actual635 SQLite3/3passed. Actual637 browser/data/API12/12passed with real Home, React and IndexedDB, owner/Worker denial, lost commit response, renderer reload and Home restart. Recovery6384/4passed including stale negative proof and foreign receipts. Full messaging639133passed/0failed/1ignored. Compatibility6406/6passed including different-session paired contacts, three human-acceptance cases, full desktop draft/mode switching and actual unread presentation. The screenshot was inspected. These results cover contact follow-up on source newer than full632.

## Draft and navigation follow-up implemented, final gates pending

Scoped IndexedDB conversation-view records persist unsent text, prior-run association and scroll position. Atomic revision comparison preserves conflicting local edits until an explicit overwrite. Late storage restoration cannot replace current input. Optional local draft_token binds the persisted text version to the outbox request and stays outside the Home message command. After a committed send followed by failed draft clearing, restart reconciles the exact matching accepted receipt and clears only that saved draft. New edits and scroll changes retain their appropriate identities.

Navigation is now independently persisted in IndexedDB by Home and owner. Startup metadata reads restore the selected contact even when it lies outside the first directory page. A new user navigation action fences a late restore. LocalStorage remains a compatible preference mirror. The conversation storage exposes save/retry/conflict state in the actual composer.

64115passed. Initial642 found lost best-effort LocalStorage navigation after process termination, corrected with durable navigation.643 actual Chrome restart passed after injected real IndexedDB post-send clear failure, exactly one Home message and one POST, no Coordinator or budget change.64417passed with two-contact Chrome restarts and draft isolation.645 identified missing TextEncoder in the old VM-only lifecycle harness, corrected to provide browser globals and permit only scoped GET metadata.64614passed.6478passed across native IM pipelines, actual React configuration UI, human acceptance/revision, complete desktop drafts/mode switching and paired runtime rotation.6485passed after moving contact preferences under team management, including both actual Chrome restart cases. Screenshot inspected. Evidence/drafts-648 retains successes and failures.

## Selected-project inspection follow-up

The native directory-anchored reader now supports selected GitHub workflows, GitLab CI, four skill roots (`skills`, `.agents/skills`, `.codex/skills`, `.claude/skills`) and the plugin manifest. Fixed selectors, directory identity checks, no-follow component opens, hardlink refusal, bounded inventories/content/output and actual child-stop waiting preserve the selected-project boundary. Complete or missing inventories update only the current selected cache; partial inventories retain prior facts. Immutable draft receipts preserve earlier observations. Optional pending_checks persist coverage alongside facts, while old records omit the empty field.

Actual659 exercised the official Builder loop, lost observation/save replies, selected inventories and provenance. Actual661 passed both released desktop Builder paths, including controlled startup. Actual668 passed7 focused tests before the final root-skills/pending-check persistence extension. Latest669 passed5 native filesystem tests. Latest670 passed248 bridge library tests with1ignored, then built the matching server successfully. Source-current official Builder and persistence verification671 passed12/12 with no failures or skips in28.79s, including both internal official Builder cases and persisted root-skills/pending-check observations. Evidence/project-inspection-671 retains the logs. Runtime evidence is macOS; Linux descriptor implementation remains unexecuted here. Versioned dependency registration/injection is still outstanding.

## Native Session history and intervention follow-up

Checkpoint722 proves local Worker native-history navigation through the actual released desktop, inert input, rejected public writes without history or Agent activation changes, and ordinary configured Session drafts through mode switching. Focused721 passes31tests. Local688 and paired-Hub691 prove takeover/stop/accounting/restart/revalidation, with Coordinator notice690. The native adapters depend on pinned dsh0.2.1-rc.2 Gateway/promotion entries. Direct navigation currently covers local Workers. Remote raw history is viewed at its execution Host. Source-current final aggregate and project gates remain required.

## Workflow dependency follow-up

Checkpoint731 implements the previously missing versioned Skill/Plugin instruction-resource contract. Native730 proves actual scoped Worker injection and Home model provenance, rejection of absent/changed provenance, source-version freezing and independent stages. API preflight rejects missing/hash/Host/tool/capability/network gaps without budget reservations. Browser731 proves owner review of source, hashes, permissions and escaped instruction text. Resources carry complete bounded instructions and require registered Host tools. Executable package installation uses a separate owner procedure. Evidence/workflow-dependencies-731 retains logs, screenshot and hashes.

## Remaining final acceptance requirements

| Source requirement | Current authoritative finding | Required next verification |
|---|---|---|
| Managed CLI roles and whole-product acceptance | Explicit native Worker/Builder/Coordinator routing, grants, accounting and known native usage are implemented. Actual free-hy4 all-role local delivery passes30decisions. Builder interview passes4actual decisions. | Complete actual Builder proposal/activation and remaining product, remote and AC1–AC13 acceptance. |
| Whole-source dsh and exact project checks | Latest-main exact project check passes967Rust tests with7ignored and GUI0errors/2warnings. Current Node aggregate is diagnostic after a test-fixture correction, whose focused rerun passes. | Collect the aggregate, address other failures if present and obtain a fixed-source complete Node result plus final required project checks. |

Native history, workflow instruction dependencies and managed CLI roles have focused implementation evidence. Whole-source gates and the remaining requirement-by-requirement audit still govern final acceptance.

## Remaining audit work

Inspect the remaining P0–P6 tasks against current implementation and actual test scope, including skill/dependency binding, configurable workflow/delivery endpoints, complete resource coverage and known-exhaustion rejection, human question routing, task-worktree integration, bounded refresh/message pagination, v1 compatibility and schema rollback. Retain exact optional authenticated/installed-provider skips; do not run paid or daily-environment checks without authorization. Run current exact project check after full Node regression to avoid artificial CPU oversubscription.

### Checkpoint746 — unknown-tool retry requires inference admission

A valid adversarial app-server run in the same explicit plan mode emits an unregistered kode_unadvertised function. The CLI completes after two localhost model requests and two usage samples without any item/tool/call or item/tool/requestUserInput callback. Total usage is20input/4output. Exact assertions passed. This demonstrates that the successful pending-tool interrupts in742/745 cannot establish a single-inference invariant for arbitrary model output. A production adapter requires model-request admission or another verified invocation bound in addition to tool interception. The per-step callback-only design is insufficient. The generated probe/result is retained in evidence/cli-worker-contract-745. No production CLI admission guards were relaxed.

## Checkpoint749 — managed CLI inference gate component

Added codex-model-gate.js to reserve and authorize one provider request per managed CLI decision. It checks the actual requested model, optional reasoning effort and advertised tool names, forwards to one fixed owner-configured HTTPS/loopback endpoint, rejects further requests and redirects, and joins listener shutdown while aborting upstream streaming. Concurrent requests cannot pass the owner admission check twice. Network/admission errors return bounded diagnostics. Provider authentication is passed through without storing it in gate state or diagnostic messages. Hop headers and decompressed SSE encoding are handled explicitly.

Actual749 passes10tests with real HTTP servers, including automatic retry refusal, concurrent pending-admission fencing, model/tool/route/effort rejection, ambiguous admission errors, redirect refusal, compressed SSE, cancellation and lost upstream response without replay. Actual installed app-server probes747/748 use the production gate, generated empty CLI config and localhost synthetic Responses inference.747 interrupts a pending known tool and preserves12reported tokens with exactly one upstream request and one admission.748 emits an unknown tool, attempts a second model request and ends failed at the gate. Only one upstream request and12tokens are observed. This closes the request-count primitive exposed by746. Both exact result assertions pass. Evidence/cli-model-gate-749 retains logs, probes and source hashes.

The gate is an adapter component. Assignment creation, CLI model/effort preparation, durable CLI custody, final evidence and the normal team pipeline are not yet wired to it. P2.5 remains incomplete. No existing dsh/native guards were relaxed. Frozen735 is still live and covers its original1127files, all unchanged. The new gate and its test are additions outside that snapshot. Three additional independent Host-crash reproductions736a/b/c all pass; the aggregate failure remains unresolved until its stack is collected.

## Checkpoint751 — aggregate terminal result and timeout diagnostics

Durable735 exited1 at2026-11-04T07:04:19.500Z after2503.24s. Node reports883tests,878passed,1failed,4skipped. All four paired-Hub official lifecycle scenarios passed, including takeover-tool1044055ms. The sole failure is collaboration-host-crash.test.js receive timeout after10000ms, with total19704ms. Its original stack has no operation/startup label. Skips are the explicitly opt-in installed Claude/Cursor/CodeBuddy ACP contracts and installed Codex concurrent-thread/model-discovery contract. They remain unexecuted; separate owned Codex protocol probes do not replace all those contracts. Evidence/regression-735 retains the exact log, terminal state, original1127file manifest and failing test source.

Three independent single-file repetitions736a/b/c and two four-way concurrent rounds all passed. They do not diagnose or close the aggregate failure. Added bounded startup generation, waiting operation and child IPC/exit state to the timeout error without increasing its10000ms or the overall40000ms limit. Source-current751 passes1test/0fail/0skip in2.33s while project checks are running. Future aggregate failure will identify the stalled boundary. The root cause and final all-source dsh pass remain open.

Exact project gate750 now runs pnpm_config_verify_deps_before_run=warn ./run.sh check under durable supervisor29949 with child29951. Its manifest includes1129files, adding the CLI gate and test and updating the Host-crash test diagnostics. The initial checks show the live process progressing through Rust workspace/GUI checks. No terminal project result is asserted here. New CLI component wiring and complete P2.5 workflow validation remain required.

## Checkpoint750 terminal — exact project gate passed

The exact pnpm_config_verify_deps_before_run=warn ./run.sh check command exited0 at2026-11-04T07:11:38.636Z. Parsed Rust result groups total932passed/0failed/6ignored. Svelte-check reports0errors/2warnings. All1129manifest files match current bytes with no changes/missing files. Evidence/project-check-750 retains the full log, terminal state, source manifest and parsed result. This gate covers the project checks executed by run.sh. The failed all-source dsh aggregate735 and incomplete CLI workflow integration remain open requirements.

## Checkpoint756 — isolated managed Codex decision actor

Added CodexManagedDecision to prepare a fresh isolated CLI thread, validate actual model/provider/effort/cwd/permission metadata before inference, intercept pending tools/questions, preserve native usage, and return proposed Host tool calls only after confirmed process-group drainage. Failed/uncertain stop suppresses proposed effects. Each actor uses the request gate from749, an explicit inference endpoint, no automatic HTTP/SSE retries, disabled native execution/plugins/hooks/subagents and a bounded event/output buffer. Only explicit profile environment is passed to the child; HOME/CODEX_HOME/XDG_CONFIG_HOME are owned temporary directories. This actor currently supports text workflow context and does not use the user's daily CLI configuration/login. Authentication can be supplied explicitly through an environment-variable name at runtime; no real credentials were used in these tests.

RpcProcess now accepts optional app-server arguments and an explicit clean-environment switch. spawnAgent retains its ordinary inherited-environment default. Native Session/controller/process compatibility is covered by the selected old tests. Preparation and close share the preparation promise to prevent creating a late CLI process or orphan configuration directory after cancellation. The gate listener uses the same cancellation signal. Actual installed CLI startup initially rejected a non-existing CODEX_HOME; both owned config directories are now created before launching, with a regression fixture requiring that directory.

Current756 regression exits0 with30passed/0failed/0skipped. It covers normal/text/question/extra-inference/mismatched-metadata paths, unconfirmed stop, cancellation during inference, clean environment, simultaneous prepare/close, the10request-gate cases and existing Codex Session/process behavior. Actual installed app-server probes752/754/755 consume the production actor, generated empty CLI config and synthetic localhost Responses inference. Each has exactly one admitted upstream request,10input/2output tokens, exited leader and empty process group.752 returns the original pending tool without executing it.754 refuses the CLI's automatic second inference while preserving first-call usage.755 returns owner-question data after interrupting the native question. Exact assertions pass and evidence/cli-decision-756 retains scripts/results/logs/hashes.

The actor is not yet connected to Assignment dispatch, capability publication, official preparation/model provenance/accounting, Home question routing and the team pipeline. Explicit account/provider configuration, durable runtime custody and full WorkRun recovery still require integration. P2.5 remains incomplete and no existing managed admission guards were relaxed. Project750 predates these new JavaScript changes. Its successful result remains evidence for that snapshot; source-current final gates are still required after integration. The aggregate Host-crash timeout735 also remains open with phase diagnostics751 available for another aggregate run.
