# Resume Flow Bug - Executive Summary

## The Bug
When users resume a previous session from the history list in BackendChooser, the tab doesn't immediately show the resumed session's metadata (model, title, token count). The tab appears with default/empty values and only updates much later (or never) after new interactions occur.

## Root Cause (Most Likely)
**The jsonl tail doesn't emit historical metadata on resume.**

### Flow Breakdown

```
User clicks "Resume session"
  ↓
Frontend calls ipc.spawnSession(backendKey, ..., resumeSessionId=uuid)
  ↓
Tauri command spawn_session() receives resumeSessionId
  ↓
LocalTransport::spawn() creates kode_core::Session with resume_session_uuid
  ↓
LocalTransport also starts jsonl tail via bridge::semantic::spawn()
  ↓
spawn_session() returns SpawnedSession (with current/default model/title)
  ↓
Frontend creates tab from SpawnedSession (model/title are defaults!)
  ↓
Tab is now visible but has NO historical metadata
  ↓
jsonl tail task (async) starts reading the .jsonl file
  ↓
??? Does it read historical data? Or seek to end and wait for new lines?
  ↓
CoreEvent::JsonlMeta is (eventually) emitted
  ↓
Frontend receives session-meta event
  ↓
Tab updates (if metadata was emitted)
```

The problem: **Step 9 is the critical question**. If jsonl tail seeks to EOF, it will only emit metadata when NEW lines are written, which happens AFTER the child process starts up and interacts.

## Critical Issues Found

### Issue #1: Missing Historical Metadata Emission
- jsonl tail is started AFTER the return value is constructed
- No guarantee that historical metadata is read before frontend renders
- `bridge/semantic.rs::run()` may seek to end of file instead of reading history

### Issue #2: Race Condition
1. spawn_session() returns immediately → Frontend renders tab with defaults
2. jsonl tail task spawns async and *eventually* reads file
3. Child process starts and loads history
4. Only when child writes new entries does metadata emit

### Issue #3: File Path Resolution on Resume with cwd Override
```
Original session:
  cwd=/project/A → .jsonl at ~/.codebuddy/projects/project-a/uuid.jsonl

Resume with:
  cwd=/project/B, same uuid → Tries ~/.codebuddy/projects/project-b/uuid.jsonl
  
Result: File not found! → jsonl tail doesn't start → No metadata sync
```

### Issue #4: Session UUID Not Always Available
- If child process hasn't started yet, `session.session_id` may be None
- jsonl tail can't find file without UUID

## Evidence Trail

### Frontend Side (✓ Confirmed Working)
- BackendChooser correctly passes `resumeSessionId` to `newTab()`
- `newTab()` passes it to IPC command
- `sessions.ts` event handler is properly subscribed to `session-meta` events
- Handler correctly updates tab state when event arrives

### Tauri/IPC Side (✓ Confirmed Working)
- `commands.rs::spawn_session()` receives and wraps `resume_session_id`
- Passes to `SpawnSpec` correctly
- `LocalTransport::spawn()` receives it and passes to `Session::new()`

### Backend Problem (✗ NOT Confirmed - Likely Issue)
- `LocalTransport::spawn()` calls `bridge::semantic::spawn()` AFTER returning SpawnedSession
- **No guarantee** that jsonl tail has read historical metadata before frontend renders
- `bridge/semantic.rs::run()` implementation unclear - need to verify it:
  1. Finds the correct .jsonl file path
  2. Reads entire file (not just new lines)
  3. Emits `CoreEvent::JsonlMeta` with historical data
  4. Does this BEFORE or AFTER child process outputs?

## Diagnostic Checklist

To confirm the bug, check for:

1. Browser console: Do you see `[session-meta]` logs when resuming?
   - YES → metadata is being emitted (frontend handler is working)
   - NO → metadata is NOT being emitted (backend issue)

2. Backend logs (add debug output to verify):
   - Is `bridge::semantic::spawn()` called?
   - Does it find the .jsonl file?
   - Does `run()` seek to start or end of file?
   - Are `CoreEvent::JsonlMeta` events being created?

3. Tab history in ~/.codebuddy/projects/:
   - Does the .jsonl file exist?
   - Does it have historical metadata entries?
   - Is it in the expected location?

## Solution Direction

The fix likely involves:

1. **Eagerly read historical metadata before spawn_session() returns**
   - OR at least before frontend renders the tab

2. **Ensure jsonl tail seeks to file start and reads ALL lines on resume**
   - Not just new lines
   - Emit all historical metadata as CoreEvent::JsonlMeta

3. **Handle cwd override case gracefully**
   - Use UUID to find .jsonl globally (not just in cwd-specific path)
   - Or pre-load metadata in spawn_session() return value

4. **Synchronize metadata before tab creation**
   - Make jsonl tail read synchronous on resume
   - Or pass historical metadata in SpawnedSession response

## Key Files to Investigate

1. **`apps/gui/src-tauri/src/bridge/semantic.rs`** (Lines 37-100)
   - How does `spawn()` resolve .jsonl path on resume?
   - How does `run()` seek/read the file?

2. **`apps/gui/src-tauri/src/transport/local.rs`** (Lines 86-187)
   - When/how is jsonl tail started relative to spawn return?
   - Is there a timing issue?

3. **`kode-core` crate** (not in GUI tree)
   - How does `Session::new()` use `resume_session_uuid`?
   - What does `--resume <uuid>` do in the child process?

## Next Steps

1. Add debug logging to `bridge/semantic.rs::spawn()` to verify file resolution
2. Trace jsonl tail execution to see if it reads historical entries
3. Check if `CoreEvent::JsonlMeta` is emitted with historical vs current data
4. Verify tab is updated when `session-meta` event arrives
5. Consider pre-loading metadata synchronously before spawn returns
