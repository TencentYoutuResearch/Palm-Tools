# Full dsh shell acceptance: evidence and next executable gate

Checkpoint 470, 2026-11-03. Read-only inspection while regression 469 holds the source freeze. This is not an AC10 pass or a claim that production desktop was exercised.

## What current source proves

- `packages/collab/navigation.js` changes the layout panel and local view mode only. The no-argument new-session action opens Builder in IM; explicit workspace/draft arguments switch to Session and preserve the original call payload.
- Pinned `dsh-client-ui-layout/lib/client.js:119` renders the selected main panel, defaulting to conversation; its panel action around line 408 changes only activePanelId.
- Pinned `dsh-client-ui-workspace/lib/client.js:1651` owns the mainView Session reference. Replacing or clearing the selected Session releases the previous reference; selecting a panel does not do so.
- Pinned `dsh-client-ui-conversation/lib/client.js:15722` owns per-binding InputHub shells in a WeakMap. The shell imports persisted draft on creation and is disposed by the Session context, not by composer component unmount. ComposerContentEditable around line 18090 detaches the editor DOM root on unmount. DefaultConversationViews around line 17928 unbinds draft mirroring on unmount and mirrors again on mount.
- These paths support the expected retention design. They do not prove attachment, editor, navigation or active-work behavior at runtime.

## Why existing browser evidence is insufficient

`test/support/collab-render-page.js` substitutes a local layout service, an absent Session scope and a main conversation entry containing `Native Session placeholder`. `collab-render.test.js` checks IM draft retention and fixture creation count. It never types into the native Session composer. A pass cannot certify native draft retention or the complete plugin roster.

## Next gate after the 469 source freeze is released

Create a separate isolated-profile browser test using the shipped dsh base + web-app + Kode plugin roster. Use a temporary DSH_HOME/KODE_DSH_HOME, temporary project and isolated Hub; retain existing daily profile/services untouched. Resolve existing dependency links without installing packages. Keep model execution deterministic and no paid inference. Do not emit authentication URLs, cookies, token contents or raw startup logs.

Required assertions:

1. Actual shipped layout/sidebar/workspace/conversation modules boot with the Kode collab plugin; native Session composer is visible and editable.
2. Enter an unsent native Session draft using browser input, switch to IM, select a contact and enter a different unsent IM draft. Switch back and verify the exact native text and same Session identity. Repeat and verify the IM draft/contact identity.
3. Capture relevant Hub task/assignment and permission revisions plus model-call counts before switching. Pure navigation must not create a task/call, change authorization or cancel an active Worker.
4. In a running controlled workflow, switch repeatedly; let work finish and verify the same delivery/evidence and reconciled budget. Native Session behavior must remain usable afterward.
5. Exercise no-argument new action in IM (Builder), explicit workspace/draft action (Session with unchanged payload), and return navigation. Use native services, not a fake created counter.
6. Inspect screenshots at desktop and narrow widths; verify keyboard access and readable controls. Browser errors must fail the test with bounded diagnostics, excluding credentials.

The shared isolated profile setup pattern exists in the repository integration scripts; reuse only the desktop Host/profile construction, not mobile or daily-environment operations. Full desktop gate must remain distinguishable from existing lightweight collab rendering tests. Failure should lead to the minimal product fix, not replacing the real composer with a fixture.
