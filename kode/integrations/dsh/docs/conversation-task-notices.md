# Channel task references in long-lived private conversations

The private conversation includes a read-only **频道任务提醒** section. It lists current requests for an owner answer and terminal task references. Terminal tasks are collapsed. These are live references, not new chat messages, push deliveries, unread counts, generated summaries, or a merged model history.

## Existing identities and access

- The owner-only GET `/api/v1/messaging/conversations/:id/task-notices` resolves the conversation to its exact Team. The Host facade exposes it through `view=task-notices` on the existing conversation route. Session credentials cannot use it.
- Every read uses one SQLite read transaction and the existing Task guard. The original and archive surfaces must remain enabled, registered in the exact Home/Host/workspace/root scope, on their recorded audience revisions, and valid for the recorded Team revision.
- This first slice includes only channel-origin tasks whose origin and archive each contain exactly that one Team. It does not expand the supported audiences or expose private-origin task history.
- A task's exact WorkRun, Team revision, supported source version, task/context identity, scope, archive/thread and audience revisions must match. Existing v1 and v2 sources remain supported. No generic WorkRun API is used as a fallback.
- The response contains the approved task-label excerpt, channel label, exact navigation references, answer-request group count and current state. Question bodies, original discussions, result bodies and Worker logs remain at the source. The count means groups of questions, not individual questions. Queued answers are removed from the pending-question projection by the existing answer path.
- Stopping or unknown run states do not become answer prompts. No cancel, recovery, takeover, approval or execution behavior is added or changed.

## Navigation and lifetime

Clicking a reference re-reads the guarded Task, validates the current archive surface and exact scope, then reads the guarded Task again before opening the existing channel/thread renderer. The current registered workspace catalog is checked before selection. Plain private-message input never answers a channel question automatically.

Each response scans at most 32 task identities, with an explicit next cursor. A filtered page may be empty while later pages remain; the UI says “本页” and “还有更多”. The section is not a claim that every task is on the first page. Results are collapsed and do not reappear as newly delivered notifications on refresh.

The visible private conversation rechecks every 15 seconds and on return to visibility. Each refresh, hidden state, read failure, scope/Team revision change or rejected navigation removes the prior displayed references. References are not saved to local storage or conversation history. This is bounded polling, not instantaneous revocation notification; every click rechecks access. Late or aborted reads cannot open a different conversation or restore old content.

## Verification

- Rust collaboration module: 58 passed, including seven new notice tests for read-only behavior, restart/deduplication, all guarded boundaries, bounded/empty pages, v1 compatibility, wrong run references, answered/stopping states, and real HTTP owner/session authorization.
- Targeted Node route/model checks: 12 passed, covering cross-Team/workspace/Host/root rejection, duplicate/bounded pages, exact guarded navigation, revocation and aborted responses.
- Controlled real isolated Hub and shipped renderer: same-name channels return to the exact thread; restart/refresh retain task identity without duplicate rows; rejected navigation opens nothing; revocation removes old labels; 1440px and collapsed-sidebar 390px layouts retain the composer. Zero model starts, native Session creation or additional business writes.
- No-provider Node suite: 1,703 tests, 1,364 passed, 339 environment-gated skips, zero failures. Skipped live-provider/environment checks remain untested.

The controlled fixture does not establish live model/business acceptance. No commit, publication, daily-service replacement or production-account change is part of this feature.
