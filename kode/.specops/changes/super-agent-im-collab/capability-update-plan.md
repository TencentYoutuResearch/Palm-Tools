# Existing capability assessment updates

Status: backend atomic command and owner bridge implemented in increment 438; real-Hub focused tests pass. Review UI and actual browser/IndexedDB/Hub response-recovery path implemented in increment 440. Broader activation, in-flight selection and complete acceptance remain pending. This is within AC5, not a new delivery goal.

## Confirmed implementation boundaries

- `teams::Store::save_team_in` already appends an immutable team revision inside a caller-owned transaction, retaining Superagent/conversation identity.
- `capability_profiles::save_in` appends immutable revisions, binds host/profile/model permanently and requires `replace_pins` to change/remove pinned assessments.
- `team_policies::write_in` can append a scheduling revision in the same transaction. Activation snapshots and WorkRun contexts reference immutable revisions.
- `team_resource_setup` deliberately requires the resulting capability revision to equal the team target reference; existing scheduling setup makes the same check. The initial frontend cannot simply remove its revision-1 guard.

## Owner command

Add a dedicated owner-only team capability-update command and exact-request receipt lookup. Input: request_id, expected team revision, target_id, expected scheduling revision, expected capability revision, full reviewed assessment map, explicit replace_pins. Do not accept caller-supplied resource identity, grants, budgets, model/executor changes or activation flags in this command.

One Hub transaction must:

1. Resolve exact historical command receipt before examining current state. Same request identity with different content fails.
2. Read latest team and scheduling policy; compare all expected revisions and team ownership. Resolve the target and its selected capability profile from that scheduling policy.
3. Check host/profile/model and selected revision against the team target. Require the profile's latest revision to match the explicitly reviewed expected revision. Do not silently merge a concurrently edited assessment.
4. Append the capability revision using existing validation and pinned-assessment protection. New/changed user-entered facts retain user provenance; this endpoint cannot manufacture measured evidence.
5. Clone the team specification and modify only this target's capability revision. Clone scheduling policy and modify only this target's matching capability reference. Preserve other targets even when they share the old profile: their immutable references stay unchanged.
6. Save team revision and scheduling revision, then exact command/result receipt and human-attributed audit event. Every write rolls back if any validation fails.
7. Return the saved configuration and explicit activation_performed=false, eligible_for_execution=false. Saving does not rewrite active snapshots, dispatch work or change running task decisions.

## Review interaction

Expose editing from team management for a currently selected scheduling capability. Read the actual referenced profile, preserve all assessments unless the user explicitly changes/removes them, and show existing fixed preferences. Before confirmation show affected target, old/new revisions, assessment changes and whether fixed preferences are replaced. Pending IndexedDB command is immutable across response loss/reload. Refresh current team/configuration after confirmation; apply through the existing explicit activation flow. Explain that saved draft and currently active revision may differ.

## Required evidence

- Real-Hub atomic save/restart/exact-retry; stale team/policy/profile revision and changed-request refusal.
- Changing/removing pinned entries fails without explicit replacement; unchanged pins survive normal edits. Other targets, resource bindings, grants, budgets and current activation snapshot remain unchanged.
- Existing WorkRun context/selection remains on its frozen revision; new activation uses the newly confirmed references and still enforces capability/budget/grant hard filters.
- Worker/non-owner cannot write. No user-supplied measured provenance or extra mutation fields accepted.
- Actual browser review, cancel, response loss/reload/recovery and subsequent explicit activation. Save alone must not start a session or Worker.

Aggregate 428 has terminated; its failures remain tracked. Source freeze ended before integration. No new permission is needed within the active Goal; daily installation/paid inference remain outside scope.
