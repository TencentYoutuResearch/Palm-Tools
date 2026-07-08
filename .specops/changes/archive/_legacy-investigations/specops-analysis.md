# SpecOps GUI Feature Analysis

## Overview
SpecOps is a spec-driven execution feature integrated into the kode GUI (Phase v0.2, Tauri 2 + SvelteKit). It allows users to open a Git workspace in a dedicated SpecOps console running in a separate window via iframe.

**Key Architecture**: One workspace owns one `specops serve` child process (non-PTY). The child outputs a structured JSON "ready" message on stdout containing HTTP origin + auth token. All subsequent traffic flows over HTTP.

---

## File Locations

### Frontend (SvelteKit/Svelte):
1. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/lib/SpecOpsPanel.svelte`** (57 lines)
   - Displays the SpecOps iframe fullscreen panel
   - Props: `session` (SpecOpsSession) + `onClose` callback
   - Renders iframe with token injected via URL fragment: `${session.origin}/#token=${token}`

2. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/lib/ipc.ts`** (711 lines)
   - **Lines 27-31**: `SpecOpsSession` TypeScript interface
     ```typescript
     export interface SpecOpsSession {
       origin: string
       token: string
       workspace: string
     }
     ```
   - **Lines 222-224**: SpecOps IPC commands
     ```typescript
     openSpecOpsWindow: (session: SpecOpsSession) => invoke<void>('open_specops_window', { session })
     specopsOpen: (workspace: string) => invoke<SpecOpsSession>('specops_open', { workspace })
     specopsClose: (workspace: string) => invoke<void>('specops_close', { workspace })
     ```

3. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/App.svelte`** (1915 lines)
   - **Lines 75-78**: State for SpecOps session management
     ```typescript
     let specopsSession: SpecOpsSession | null = $state(null)
     let specopsOpening = $state(false)
     let specopsError: string | null = $state(null)
     ```
   - **Lines 128-158**: `openSpecOps()` function
     - File picker: "Open a Git workspace in SpecOps"
     - Calls `ipc.specopsOpen(workspace)` to spawn server
     - Then calls `ipc.openSpecOpsWindow(session)` to create window
   - **Lines 160-166**: `closeSpecOps()` cleanup
   - **Lines 514-518**: Command palette entry
     ```typescript
     {
       id: 'specops-open',
       label: specopsSession ? 'Open SpecOps window' : 'Open SpecOps console…',
       detail: '⌘S',
       run: () => { void openSpecOps() },
     }
     ```
   - **Line 428**: Keyboard shortcut `Cmd+S` triggers `openSpecOps()`
   - **Lines 1105-1111**: Error notification toast

### Backend (Rust/Tauri):
1. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/specops.rs`** (237 lines)
   - Core SpecOps lifecycle management
   - **Struct `SpecOpsSession`** (lines 18-23): Serializable session data
   - **Struct `SpecOpsManager`** (lines 45-48): 
     - Manages one `specops serve` child per workspace
     - Uses `HashMap<PathBuf, ManagedChild>` with `Mutex`
   - **Method `open()`** (lines 51-156):
     - Canonicalizes workspace path
     - Checks if existing child is still alive; kills if not
     - Runs `specops init --workspace <path>` if `specops.toml` missing
     - Spawns `specops serve --workspace <path>` with env vars:
       - `KODE_BRIDGE_URL`: Bridge HTTP origin
       - `KODE_BRIDGE_TOKEN`: Bearer token for auth
     - Reads first line from stdout (structured JSON ready message)
     - Validates: `type=="ready"`, `origin.startswith("http://127.0.0.1:")`, token length ≥ 32
     - Returns `SpecOpsSession` on success
   - **Method `close()`** (lines 158-165): Graceful shutdown + cleanup
   - **Fn `parse_ready()`** (lines 176-186): JSON parse + security checks
   - **Fn `specops_command()`** (lines 188-219): Binary discovery logic
     - Priority: `KODE_SPECOPS_BIN` env → sidecar next to executable → `../../specops/dist/cli/main.js` (Node)

2. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/commands.rs`** (lines 24-48)
   ```rust
   pub async fn specops_open(workspace: String, state: State<'_, AppState>) 
     -> Result<SpecOpsSession, String>
   
   pub async fn specops_close(workspace: String, state: State<'_, AppState>) 
     -> Result<(), String>
   
   pub async fn open_specops_window(app: AppHandle, session: SpecOpsSession)
     -> Result<(), String>
   ```
   - **`specops_open`** (lines 24-40):
     - Retrieves bridge URL/port from `state.ctx.listen_addr`
     - Spawns blocking task to call manager.open()
   - **`open_specops_window`** (lines 726-748):
     - Creates new Tauri webview window with label: `specops-{timestamp_ms}`
     - Builds URL: `{session.origin}#token={encoded_token}`
     - Window size: 1200x800
     - Window title: "SpecOps - Constraint Rail"

3. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/lib.rs`** (line 22 + 123-125)
   - Declares mod specops
   - Registers Tauri commands

4. **`/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/state.rs`** (lines 67-68 + 175)
   - **AppState field**: `pub specops: Arc<crate::specops::SpecOpsManager>`
   - Initialized in `AppState::new()`

---

## Issue Analysis: "+ New" Button & Spec Viewing

### Current State:
✅ **Working**:
- File picker dialog for workspace selection
- SpecOps server spawn & lifecycle management
- Separate window creation with token injection
- Command palette entry (⌘S)
- Error handling toast

❌ **NOT Found / Missing**:
1. **No "+ New Spec" button** in the SpecOpsPanel or anywhere visible
   - SpecOpsPanel is just an iframe wrapper; all spec CRUD UI must be in the SpecOps web app itself (not in kode GUI)
   - The kode GUI just hosts the iframe pointing to `http://127.0.0.1:<port>/#token=<token>`

2. **No spec details viewer in kode GUI**
   - All spec viewing happens inside the iframe (delegated to SpecOps web app)

3. **Potential bugs/issues**:

   **Issue 1: Token URL Fragment Encoding**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/commands.rs:737`
   - Current code:
     ```rust
     let encoded_token = url::form_urlencoded::byte_serialize(session.token.as_bytes()).collect::<String>();
     let url_str = format!("{}#token={}", session.origin, encoded_token);
     ```
   - **Problem**: Using `form_urlencoded` for fragment is **incorrect**. Fragment component should use `%` encoding directly, but `form_urlencoded` is meant for application/x-www-form-urlencoded body encoding. While it often produces the same result for alphanumeric tokens, it's semantically wrong and could cause issues with special characters.
   - **Fix**: Use proper percent-encoding (URL encode only): `urlencoding::encode()` or `url::percent_encode()`

   **Issue 2: No URL validation before creating window**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/commands.rs:739-741`
   - The URL is parsed with `url::Url::parse()` but only validated *after* construction:
     ```rust
     let url = url_str.parse::<url::Url>()
         .map_err(|e| format!("invalid specops url: {e}"))?;
     ```
   - This is fine, but the error message doesn't distinguish between malformed scheme, path, etc.

   **Issue 3: Inline "Open SpecOps window" vs. initial workspace selection UX**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/App.svelte:128-137`
   - If user has already opened SpecOps, clicking the command palette item will just re-open the window without allowing workspace selection change.
   - **Current behavior**: 
     ```typescript
     if (specopsSession) {
       // 已有 session,直接打开独立窗口
       try {
         await ipc.openSpecOpsWindow(specopsSession)
       } catch (error) { ... }
       return
     }
     ```
   - This is intentional per the comment ("already has session, directly open window"), but users can't switch workspaces without closing the entire session first.

   **Issue 4: No "already exists" check before spawning**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src-tauri/src/specops.rs:60-70`
   - The code does check if a child is still alive:
     ```rust
     if let Some(existing) = children.get_mut(&workspace) {
         match existing.child.try_wait() {
             Ok(None) => return Ok(existing.session.clone()), // Still alive
             Ok(Some(_)) | Err(_) => { // Exited or error
                 existing.stop();
                 children.remove(&workspace);
             }
         }
     }
     ```
   - ✅ This is actually correct — reuses session if process still running, kills stale process otherwise.

   **Issue 5: No workspace persistence**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/App.svelte:75-78`
   - `specopsSession` is in-memory only; no persistence to `state.json`
   - Closing and reopening kode GUI loses the SpecOps workspace reference
   - Users must re-select workspace each time

   **Issue 6: Async window creation race condition**
   - **Files**: `App.svelte:145-148` + `commands.rs:726-748`
   - User clicks "Open SpecOps", then immediately clicks "Open SpecOps window" before spawn completes
   - No `specopsOpening` guard on the second call; both call `openSpecOpsWindow()` simultaneously
   - **Current guard**: Only guards the initial spawn, not the follow-up window open
   - **Potential fix**: Set `specopsOpening = true` before `openSpecOpsWindow()` as well

   **Issue 7: iframe sandbox / CSP issues**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/lib/SpecOpsPanel.svelte:16`
   - Current iframe has **no sandbox attributes**:
     ```svelte
     <iframe title="SpecOps console" {src}></iframe>
     ```
   - **Risk**: If SpecOps web app is compromised, it has full access to kode GUI's Tauri API + local filesystem
   - **Fix**: Add `sandbox="allow-same-origin allow-forms allow-scripts"` (restrictive CSP)

   **Issue 8: No error recovery for failed spawn**
   - **File**: `/Users/marxwang/Projects/youtu/app/kode/apps/gui/src/App.svelte:153-154`
   - If `specopsOpen()` fails, `specopsError` is set but `specopsSession` remains null
   - Clicking "Open SpecOps console" again will retry file picker (good UX)
   - ✅ This is actually fine

   **Issue 9: Token injection via URL fragment is visible to SpecOps web app**
   - **Architecture note**: Token is passed as `#token=<value>` in URL fragment
   - Fragment is NOT sent to server on HTTP request, but IS accessible to JavaScript in the iframe via `window.location.hash`
   - ✅ This is correct — token is accessible only to the SpecOps web app (same-origin)

---

## Data Flow Diagram

```
┌─────────────────────────────────────────────────────────┐
│                  kode GUI (Tauri/SvelteKit)             │
├─────────────────────────────────────────────────────────┤
│ App.svelte                                              │
│  ├─ openSpecOps() [Cmd+S / cmd palette]                │
│  │   └─ File picker → select workspace path            │
│  │       └─ ipc.specopsOpen(workspace: string)         │
│  │           ↓                                          │
│  └─ SpecOpsSession state {origin, token, workspace}    │
│       └─ ipc.openSpecOpsWindow(session)                │
│           └─ Create separate Tauri window              │
│               └─ Load iframe: {origin}#token={token}   │
│                   ↓                                     │
└─────────────────────────────────────────────────────────┘
          │                    │
          │                    └──────────────────┐
          │                                       │
          ▼                                       ▼
┌─────────────────────────────────┐  ┌──────────────────────────────┐
│  Tauri Backend (Rust)           │  │  SpecOps iframe Window       │
├─────────────────────────────────┤  ├──────────────────────────────┤
│ specops_open(workspace: String) │  │ HTML/JS SpecOps Web App      │
│  │                              │  │  (all spec creation/viewing) │
│  └─ SpecOpsManager::open()      │  │                              │
│      ├─ specops init            │  │ Receives token via fragment  │
│      └─ specops serve           │  │ Communicates with server via │
│         (spawns subprocess)     │  │ HTTP on localhost:PORT       │
│         ├─ await ready JSON     │  │                              │
│         │  {type,origin,token}  │  │ (SpecOps server logic hidden)
│         ├─ store SpecOpsSession │  │                              │
│         └─ return to frontend   │  │                              │
│                                 │  │                              │
│ open_specops_window(session)    │  │                              │
│  ├─ encode token in fragment    │  │                              │
│  └─ create Tauri webview window │─→ iframe loads                 │
│      1200x800, label with ts    │  │ (spec UI all client-side)    │
└─────────────────────────────────┘  └──────────────────────────────┘
```

---

## Key Implementation Details

### Security Considerations:
1. ✅ Token >= 32 bytes, loopback-only origin (`127.0.0.1`)
2. ✅ Fragment doesn't leak to server logs
3. ❌ No iframe sandbox restrictions
4. ❌ No CSP headers validated

### Concurrency:
- `SpecOpsManager` uses `Mutex<HashMap>` (parking_lot) — thread-safe
- One child process per workspace; reuses if alive
- Async window creation not guarded by `specopsOpening` flag on second call

### Error Handling:
- ✅ Spawn failures → error toast
- ✅ 10-second ready timeout
- ✅ Process exit detection on reuse

---

## Recommendations for Bug Fixes

1. **HIGH**: Fix token encoding in `commands.rs:737`
   - Use proper URL fragment encoding (percent-encoding, not form-urlencoded)

2. **MEDIUM**: Add iframe sandbox in `SpecOpsPanel.svelte:16`
   - Restrict iframe capabilities (no-popup, no-storage, no-plugins, etc.)

3. **MEDIUM**: Guard second `openSpecOpsWindow()` call
   - Keep `specopsOpening = true` through both spawn and window creation

4. **LOW**: Add SpecOps workspace persistence
   - Save `specopsSession.workspace` to `state.json`
   - Restore on startup (optional re-init if workspace path changed)

5. **LOW**: Allow workspace switching
   - Add "Switch workspace" button instead of requiring session close

---

## Notes on "+ New Spec" and Spec Details

- **NO "+ New" button exists in kode GUI** — that UI is entirely within the SpecOps web app (iframe)
- **All spec CRUD operations happen in the SpecOps web app**, not in kode GUI
- kode GUI's role is only to:
  1. Let user select a Git workspace
  2. Spawn `specops serve` process
  3. Host an iframe pointing to the HTTP server with token authentication
  4. Provide window management (new window, close, etc.)

The spec creation/viewing/deletion/execution UI lives in `/apps/specops/` (not in kode GUI) and communicates directly with the SpecOps server over HTTP.

