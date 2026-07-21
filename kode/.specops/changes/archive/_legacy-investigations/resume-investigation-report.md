# Resume Flow Investigation - Complete Report

**Date:** 2026-06-19  
**Investigator:** CodeBuddy Code  
**Issue:** Resume in GUI doesn't sync tab state

## Documents

1. **RESUME_BUG_SUMMARY.md** - Executive summary with key findings
2. **RESUME_BUG_ANALYSIS.md** - Complete detailed analysis of the entire flow

## Quick Navigation

### The Problem
Users click "Resume session" → tab appears with empty/default metadata → metadata updates slowly or not at all

### The Suspect
`apps/gui/src-tauri/src/bridge/semantic.rs` - jsonl tail may not read historical metadata on resume

### The Evidence
- Frontend correctly triggers resume with `resumeSessionId`
- Tauri command receives and wraps it correctly
- Backend starts jsonl tail but returns before tail reads historical data
- Frontend renders tab with defaults before metadata arrives
- **Race condition:** Tab visible → jsonl tail starts → (async) reads file → metadata emits

### The Question
Does `bridge/semantic.rs::run()` seek to file START (read all history) or END (wait for new data)?

## All Key Files

### Frontend (Svelte/TypeScript)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/lib/BackendChooser.svelte` - Resume trigger (lines 249-251)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/lib/sessions.ts` - Tab creation & metadata sync (lines 83-191)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/lib/ipc.ts` - IPC wrapper (lines 112-137)

### Backend (Rust)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/commands.rs` - Tauri command (lines 115-177)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/transport/local.rs` - Transport spawn (lines 86-187)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/bridge/semantic.rs` - jsonl tail (**CRITICAL** - lines 37-100)
- `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/state.rs` - Event router (lines 206-310)

### External Dependencies (not modified)
- `kode-core` crate - Contains `Session::new()` with resume_session_uuid handling
- `kode-bridge` crate - Protocol layer

## Evidence Summary

### What's Working ✓
1. Frontend correctly passes `resumeSessionId` through all IPC layers
2. Tauri command receives it and wraps in `SpawnSpec`
3. `LocalTransport::spawn()` receives spec and passes to `Session::new()`
4. `session-meta` event handler in frontend is subscribed and updates tabs correctly
5. Event routing in `spawn_event_router()` properly emits events to Tauri frontend

### What's Not Working ✗
1. Historical metadata doesn't appear in resumed tabs immediately
2. Tab shows defaults until (if ever) new metadata is emitted
3. Race condition between spawn return and jsonl tail reading history

### Critical Gap
No logging/confirmation that:
- jsonl tail actually reads the resumed session's .jsonl file
- `CoreEvent::JsonlMeta` is emitted with historical data (not just new interactions)
- Frontend receives session-meta events when resuming

## How to Verify

### From Frontend
1. Open browser DevTools
2. Resume a session from history
3. Check console for `[session-meta]` debug logs
4. If no logs appear → metadata is not being emitted
5. If logs appear with old model/tokens → backend is working

### From Backend
1. Add debug logging to `bridge/semantic.rs::spawn()`:
   - Log the resolved file path
   - Log whether file was found
2. Add logging to `bridge/semantic.rs::run()`:
   - Log file seek position and initial read
   - Log every `CoreEvent::JsonlMeta` emission
3. Check Tauri logs for `CoreEvent::JsonlMeta` emissions

### Check File System
```bash
# List all session files for a project
ls -la ~/.codebuddy/projects/*/

# Check if resumed session file exists
find ~/.codebuddy -name "uuid.jsonl"

# View contents of a session file
cat ~/.codebuddy/projects/project-name/uuid.jsonl | tail -20
```

## Most Likely Root Cause

**The jsonl tail seeks to the end of the file instead of the beginning when resuming.**

When a resumed session starts:
1. `.jsonl` file already exists with historical data
2. `semantic.rs::run()` opens the file
3. **BUG:** Seeks to EOF instead of file start
4. Only reads NEW lines written by the resumed child process
5. Historical metadata never emitted

**Fix:** On resume (when `is_resume=true`), ensure `run()` seeks to file start and reads all lines, emitting historical metadata immediately.

## Alternative Hypothesis

**The .jsonl file is not being found due to cwd override.**

When resuming with different cwd:
- Original session: `~/.codebuddy/projects/project-a/uuid.jsonl`
- Resume with different cwd: Tries `~/.codebuddy/projects/project-b/uuid.jsonl`
- File not found → semantic tail doesn't start → No metadata

**Fix:** Use UUID globally to find .jsonl, not just in cwd-specific path.

## Recommended Next Steps

1. **Immediate:** Add console logging to BackendChooser to verify `resumeSessionId` is passed
2. **Verify:** Check browser console for `[session-meta]` logs when resuming
3. **Debug:** Add logging to `bridge/semantic.rs::spawn()` to verify file resolution
4. **Trace:** Monitor `CoreEvent::JsonlMeta` emissions in `spawn_event_router()`
5. **Fix:** Implement proper historical metadata reading and emission on resume

## References

- CODEBUDDY.md for project context
- ROADMAP.md for Phase timeline
- Session management design is in `~/.codebuddy/plans/toasty-pulse-curie.md`
