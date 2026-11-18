---
schema_version: 2
id: fix-windows-composer-file-drop
kind: bug
document_class: work_item
work_type: bug
title: Windows 会话输入框文件拖放设计
status: in_progress
verifies:
  - typescript
paths:
  - apps/gui/src/App.svelte
  - apps/gui/src/lib/file_drop.ts
  - apps/gui/tests/file_drop.test.ts
---

# Windows 会话输入框文件拖放设计

## Event ownership

外部 Explorer/desktop drag remains owned by Tauri. The application subscribes
to both the current Webview and current Window drag events because Windows
WebView2 can deliver the synthesized event to only one target. Identical
events from both subscriptions are deduplicated. Listeners are installed
immediately inside `onMount`, before theme, backend, extension, or session
restoration awaits. HTML5 `Files` remains a fallback when native paths are
unavailable.

The event is routed in this order:

1. Workspace Files panel receives same-window native drops for file operations.
2. Remote active sessions upload local paths over SSH.
3. Local active sessions insert references through the same function used by
   internal workspace drag.

## Composer routing

`insertWorkspaceReference` already owns transport-specific insertion:

```text
ACP/runtime -> StructuredSession.insertReference
PTY         -> write_input
```

Every local external file drop must use this function. Calling
`ipc.writeInput` directly from the drop handler is removed so visible
ACP/runtime composers and terminal sessions share one behavior.

Internal workspace references use the same `@reference` formatter. This allows
repository-relative Git-row paths while external drops still pass through
absolute-path normalization first. No path is submitted; one trailing space
remains after the final reference.

## Windows path normalization

The trusted-path parser accepts:

- POSIX absolute paths;
- Windows drive paths such as `C:\work\file.txt`;
- UNC paths such as `\\server\share\file.txt`;
- verbatim drive paths such as `\\?\C:\work\file.txt`, normalized to
  `C:\work\file.txt`;
- verbatim UNC paths such as
  `\\?\UNC\server\share\file.txt`, normalized to
  `\\server\share\file.txt`;
- encoded `file://` and `file://server/share` URIs.

Bare filenames and control characters are rejected. Multiple sources are
deduplicated before insertion.

## Compatibility

Remote external drops keep the existing upload guard and insert only paths
returned by the remote bridge. HTML5 and internal workspace paths still reject
bare filenames. PTY writes remain text-only and never append Enter.

## Validation

- Pure tests cover Windows drive, UNC, verbatim, file URI and reference text.
- Existing workspace and remote attachment tests protect endpoint and upload
  behavior.
- `svelte-check`, file-drop and session-input suites verify the integrated
  frontend.
