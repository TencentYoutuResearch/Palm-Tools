# Explicit Kode sidebar extension

This is a small, reviewed adapter of the MIT dsh sidebar, not a new sidebar design.
Native panel rows, footer, locale and all existing slots remain unchanged. The two optional root slots expose the brand control and primary action without nested buttons or aria-hidden interactive descendants.

## Build/install

- Target dsh **0.2.1-rc.5** only. `npm run build:sidebar` checks both version and SHA-256 of the upstream client and reviewed patch before generating this package. A mismatch fails closed without changing installed packages.
- `npm run build:bundle` builds this package first and bundles `@kode/dsh-sidebar`. `cordis.patch.yml` explicitly replaces loader entry **ui-sidebar**, as the existing Kode chat replacement does for ui-chat. Never add a second sidebar entry or load original and wrapper simultaneously.
- Install the resulting Kode bundle through the same normal dsh bundle management flow. Do not overwrite node_modules or edit a running installed package. Restart/reload the selected profile after installing. No production profile was changed during development.
- Wrapper ModuleLoader identity is `@kode/dsh-sidebar`; native `sidebar` locale and slots stay unchanged. Plugins using public sidebar slots retain compatibility. Plugins relying on internal bundle identity may need review.

## Rollback

Disable the Kode sidebar replacement in the selected profile and restore `ui-sidebar` to `@deepseek-ai/dsh-client-ui-sidebar` at the same pinned version, or reinstall the previously working Kode bundle/profile snapshot. Reload the app. Existing Kode code falls back to workspace-level switching when the extension slots are absent. This does not delete sessions, configuration, avatars, or collaboration data.

## Scope and validation

The dependency patch was originally a proposal; this wrapper now provides an explicit build/install path. Real Chrome tests cover the native sidebar, Mac/non-Mac brand rendering, keyboard Enter/Escape, mode and draft preservation, and absence of nested/hidden controls. Controller services are isolated fixtures; this is not a full signed-in production dsh test. The macOS collapsed window-titlebar new-session shortcut is still native and is outside the expanded sidebar primary-action slot. Do not claim that shortcut is removed.

Upstream source and patch hashes are in upstream-lock.json. LICENSE.upstream is retained. For upgrades, review/rebase the patch and update both hashes intentionally; never bypass the guard.

## Title switch verification (2026-11-10)

The brand control receives the native identity element, so session mode preserves the original DeepSeek fish mark, title typography and build-version badge. Collaboration mode uses Kode’s existing red/black terminal artwork (copied without image edits from apps/gui/src-tauri/icons/128x128.png) with a Kode / ORBIT wordmark lockup. This follows the owner’s 2026-11-09 references, not the earlier generic orbit drawing. The official dsh brand plugin is loaded in the browser fixture so its deepseek / HARNESS artwork is verified too. The collaboration menu is opened from that title, not a second expanded workspace-row switch. A collapsed sidebar retains one accessible compact switch.

The controlled browser fixture now defaults to this project’s sidebar extension, matching `cordis.patch.yml`. Previously it defaulted to the stock upstream sidebar, which has no brand-control slot and therefore photographed the compatibility fallback in the workspace area. `KODE_TEST_SIDEBAR_BUNDLE` remains an explicit override for upstream compatibility testing.
