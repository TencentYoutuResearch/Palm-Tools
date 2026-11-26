/** Reuse official contiguous process groups; adapt native Agent tool classification only. */
import { createRequire } from 'node:module'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
const resolve = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json')).resolve
const upstream = process.env.KODE_CHAT_UPSTREAM_CLIENT ?? resolve('@deepseek-ai/dsh-client-ui-chat/client')
let source = await readFile(upstream, 'utf8')
function replace(from, to) { if (!source.includes(from)) throw new Error(`Pinned Chat contract changed: ${from}`); source = source.replace(from, to) }
replace('id: "@deepseek-ai/dsh-client-ui-chat",','id: "@kode/dsh-chat",')
// Imported relay messages have no live inbox claim, so remain Context nodes.
replace('node.kind !== "context" || node.data.content.some', 'node.kind !== "context" || (node.data.source?.kind === "agent-message" && node.data.source?.form === "relay") || node.data.content.some')
// Stable user-bubble seat for scene-aware appearance without matching generated classes.
replace('className: MessageItem_module_css_default.bubble,', 'className: MessageItem_module_css_default.bubble, "data-kode-user-bubble": true,')
// Keep history editing separate from the generated renderer and preserve its native bubble/actions.
const historyEdit = await readFile(new URL('../packages/chat/history-edit.js', import.meta.url), 'utf8')
const workbenchUi = await readFile(new URL('../packages/chat/workbench-ui.js', import.meta.url), 'utf8')
replace('function UserStyleBubble(', historyEdit + '\n' + workbenchUi + '\nfunction UserStyleBubble(')
// History stays append-only. Render the active transcript and hide replaced
// ranges from the native turn navigator and process groups.
replace('return isAppendSurfaceEvent(event) && !isCompactionCheckpoint(event) ? {',
  'return (isAppendSurfaceEvent(event) || isResentHistoryMessage(event)) && !isCompactionCheckpoint(event) ? {')
replace('const order = useChat((s) => s.order);', 'const rawOrder = useChat((s) => s.order);')
replace('const groupedEntries = useConversation((snapshot) => snapshot.views.grouped("chat")?.entries);',
  'const groupedView = useConversation((snapshot) => snapshot.views.grouped("chat"));')
replace('const entries = (0, react.useMemo)(() => groupedEntries ?? order.map((key) => ({\n\t\t\t\tkind: "node",\n\t\t\t\tkey\n\t\t\t})), [groupedEntries, order]);\n\t\t\tconst nodeStore = useChat((s) => s.nodes);',
  `const nodeStore = useChat((s) => s.nodes);
			const historyEdits = useProjection("kodeHistoryEdits");
			const visible = (key) => historySeqVisible(historyEdits, nodeStore.get(key)?.anchorSeq);
			const order = (0, react.useMemo)(() => historyEdits?.length ? rawOrder.filter(visible) : rawOrder, [rawOrder, historyEdits, nodeStore]);
			const entries = (0, react.useMemo)(() => {
				if (!groupedView) return order.map(key => ({ kind: "node", key }));
				if (!historyEdits?.length) return groupedView.entries;
				return groupedView.entries.filter(entry => entry.kind === "node" ? visible(entry.key) :
					groupedView.groupSource(entry.key)?.getSnapshot()?.members.some(member => visible(member.key)));
			}, [groupedView, order, historyEdits, nodeStore]);`)
replace('const turnNavigationItems = useChat((s) => s.navigation.items());\n\t\t\tconst turnOutline = useProjection("turnOutline");',
  `const navigation = useChat((s) => s.navigation.items());
			const turnNavigationItems = (0, react.useMemo)(() => historyEdits?.length ?
				navigation.filter(item => visible(item.anchorKey)) : navigation, [navigation, historyEdits, nodeStore]);
			const turnOutline = useProjection("turnOutline");`)
replace('const railItems = (0, react.useMemo)(() => mergeTurnRailItems(turnNavigationItems, turnOutline), [turnNavigationItems, turnOutline]);',
  'const railItems = (0, react.useMemo)(() => mergeTurnRailItems(turnNavigationItems, historyEdits?.length ? outlineEntries(turnOutline).filter(item => historySeqVisible(historyEdits, item?.seq)) : turnOutline), [turnNavigationItems, turnOutline, historyEdits]);')
replace('entries,\n\t\t\t\t\t\t\t\t\t\t\tpendingInputs,', 'entries,\n\t\t\t\t\t\t\t\t\t\t\thistoryEdits,\n\t\t\t\t\t\t\t\t\t\t\tpendingInputs,')
replace('function ChatFlow({ entries, pendingInputs,', 'function ChatFlow({ entries, historyEdits, pendingInputs,')
replace('const seatProps = {\n\t\t\t\tnodeStore,', 'const seatProps = {\n\t\t\t\tnodeStore,\n\t\t\t\thistoryEdits,')
replace('function ChatGroupSeat({ groupKey, useChatGroup, useGroupHeaderAction, ...props }) {\n\t\t\tconst members = useChatGroup(groupKey, (group) => group?.members);',
  `function ChatGroupSeat({ groupKey, useChatGroup, useGroupHeaderAction, historyEdits, ...props }) {
			const groupMembers = useChatGroup(groupKey, (group) => group?.members);
			const members = (0, react.useMemo)(() => historyEdits?.length ? groupMembers?.filter(member =>
				historySeqVisible(historyEdits, props.nodeStore.get(member.key)?.anchorSeq)) : groupMembers,
				[groupMembers, historyEdits, props.nodeStore]);`)
// Keep the newer DSH session panel mountable in the pinned Chat renderer.
replace('children: { "conversation.chat.flow": {', `children: {
						"conversation.chat.aside": { kind: "single", scope: "session" },
						"conversation.chat.flow": {`)
replace('(0, react_jsx_runtime.jsx)("div", {\n\t\t\t\t\t\tclassName: ChatView_module_css_default.root,', `(0, react_jsx_runtime.jsx)("div", {
						"data-chat-aside": "",
						children: renderSlot("conversation.chat.aside", {})
					}),
					(0, react_jsx_runtime.jsx)("div", {
						className: ChatView_module_css_default.root,`)
// Newer primitives use CSS anchors for these dialogs and omit the measurement hook.
replace('function useStatDialog() {', `const legacyStatPosition = _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition;
		const useStatPosition = legacyStatPosition ?? (() => undefined);
		function useStatDialog() {`)
replace('const pos = (0, _deepseek_ai_dsh_client_ui_primitives.useAnchoredPosition)({', `const anchorName = "--kode-stat-" + (0, react.useId)().replaceAll(":", "");
			const anchorStyle = legacyStatPosition ? undefined : { anchorName };
			const pos = useStatPosition({`)
replace('margin: PANEL_MARGIN\n\t\t\t});', `margin: PANEL_MARGIN
			}) ?? (anchorStyle && {
				positionAnchor: anchorName,
				positionArea: "top span-left",
				positionTryFallbacks: "flip-inline, flip-block",
				margin: "0 12px 8px",
				maxHeight: "calc(100dvh - 24px)",
				overflowY: "auto"
			});`)
replace('panelRef,\n\t\t\t\tpos\n', 'panelRef,\n\t\t\t\tpos, anchorStyle\n')
const statDialogRead = 'const { open, setOpen, rootRef, panelRef, pos } = useStatDialog();'
if (source.split(statDialogRead).length !== 3) throw new Error('Pinned statistics dialog contract changed')
source = source.replaceAll(statDialogRead, 'const { open, setOpen, rootRef, panelRef, pos, anchorStyle } = useStatDialog();')
for (const root of ['TurnUsagePanel_module_css_default.root', 'StatsPills_module_css_default.anchor']) {
  replace(`ref: rootRef,\n\t\t\t\tclassName: ${root},`, `ref: rootRef,\n\t\t\t\tstyle: anchorStyle,\n\t\t\t\tclassName: ${root},`)
}
replace('const UserMessageNodeView = (0, react.memo)(function UserMessageNodeView(', 'const OriginalUserMessageNodeView = (0, react.memo)(function UserMessageNodeView(')
replace('function UserMessageNodeView({ node, renderFactorySlot, loadImage, t })', 'function UserMessageNodeView({ node, renderFactorySlot, loadImage, t, historyEditAction })')
replace('text,\n\t\t\t\t\ttime: data.time,', 'text,\n\t\t\t\t\textraActions: historyEditAction,\n\t\t\t\t\ttime: data.time,')
replace('/** Injected-context keyed Chat renderer. */', 'const UserMessageNodeView = (props) => react.createElement(HistoryEditableMessage, { ...props, native: OriginalUserMessageNodeView });\n/** Injected-context keyed Chat renderer. */')
for (const key of ['user', 'steering']) replace('key: "' + key + '",\n\t\t\t\tlocale: NS', 'key: "' + key + '",\n\t\t\t\tinject: sessionId => historyEditBinding(ctx, sessionId),\n\t\t\t\tlocale: NS')
replace('function registerChatNodeRenderers(ctx, performanceUsage, presentation) {', 'function registerChatNodeRenderers(ctx, performanceUsage, presentation) { installHistoryEditStyle(ctx); installWorkbenchUi(ctx);')
// Keep ui-chat settings compatible with the official chat UI.
replace('function activity(name) {', 'function activity(name) {\n if (name === "kode_native_commandExecution") return "commands";\n if (name === "kode_native_fileChange") return "edit";')
// Keep running commentary visible, but fold completed process even after steering.
replace('const alwaysOpen = liveProcess || interleavedInput || turnProcessAlwaysOpen(routedNode);', 'const alwaysOpen = liveProcess || turnProcessAlwaysOpen(routedNode);')
replace('hasContent: !interleavedInput && (processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning),', 'hasContent: processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning,')
replace('presentation?.turnClosed === false || presentation?.hasInterleavedInput === true || reason', 'presentation?.turnClosed === false || reason')
replace('t("chat.deepDivingFor", { duration: formatRunDuration(Math.max(1e3, now - startTime), t).map((part) => part.text).join("") })', 't("chat.processedFor", { minutes: Math.floor(Math.max(0, now - startTime) / 60000), seconds: Math.floor(Math.max(0, now - startTime) / 1000) % 60 })')
replace('"chat.deepDiving": "深度求索中",', '"chat.processedFor": "已处理 {minutes} 分钟 {seconds} 秒",\n "chat.deepDiving": "处理中",')
replace('"chat.deepDiving": "Deep diving",', '"chat.processedFor": "Working for {minutes} min {seconds} sec",\n "chat.deepDiving": "Working",')
// A focused tool disclosure would otherwise reopen the entire process during
// the native focus-protection pass. Hand focus to its surviving Turn control.
replace('if (turn?.status !== "closed") return null;', `const controlRef = (0, react.useRef)(null);
const previousStatus = (0, react.useRef)(turn?.status);
(0, react.useLayoutEffect)(() => {
  if (previousStatus.current === "open" && turn?.status === "closed" && turn.end?.data.reason.kind === "completed") {
    const focused = document.activeElement?.closest?.("[data-chat-turn]");
    if (focused?.getAttribute("data-chat-turn") === String(node.data.turn) && !["user", "steering"].includes(focused.getAttribute("data-chat-flow-kind"))) controlRef.current?.focus({ preventScroll: true });
    turnProcess.setOpen(false);
  }
  previousStatus.current = turn?.status;
}, [turn?.status, node.data.turn, turnProcess.setOpen]);
if (turn?.status !== "closed") return null;`)
replace('className: TurnProcessNodeView_module_css_default.root,', 'className: TurnProcessNodeView_module_css_default.root, ref: controlRef,')
const contextSource = await readFile(new URL('../src/context-usage.js', import.meta.url), 'utf8')
const contextParser = contextSource.slice(contextSource.indexOf('export function nativeContextUsage'), contextSource.indexOf('const schema')).replace('export function', 'function')
const metadata = await readFile(new URL('../packages/chat/native-metadata.js', import.meta.url), 'utf8')
replace('var module = { exports: {} };', `${contextParser}\n${metadata}\nvar module = { exports: {} };`)
replace('function registerConversationNodes(ctx) {', 'function registerConversationNodes(ctx) { registerKodeContextUsage(ctx); registerKodeAssistantHistory(ctx);')
replace('function updateChunk(state, chunk, seq, time) {', 'function updateChunk(state, chunk, seq, time) { if (chunk.type === "block-start" && state.final) state = resetForRetry(state);')
replace('(settled?.interrupted === true ? settled.seq : state.firstVisibleSeq ?? settled?.seq)', '(settled?.seq ?? state.firstVisibleSeq)')
replace('status,\n\t\t\t\t\tturn: state.turn,', 'status, anchorSeq,\n\t\t\t\t\tturn: state.turn,')
replace('routedNode.kind === "assistant-step" && routedNode.data.step === processSpec.answerStep;', 'routedNode.kind === "assistant-step" && routedNode.data.step === processSpec.answerStep && routedNode.anchorSeq === processSpec.answerAnchorSeq;')
replace('node.data.step !== spec.answerStep) hasExternalProcess = true;', 'node.data.step !== spec.answerStep || node.anchorSeq < spec.answerAnchorSeq) hasExternalProcess = true;')
// Context pressure is a snapshot, separate from cumulative billed-token usage.
{
  const start = source.indexOf('const ActivityPill ='), end = source.indexOf('/** Whole-log token total', start)
  if (start < 0 || end < 0) throw new Error('Pinned activity pill contract changed')
  let pill = source.slice(start, end)
  const oldIcon = 'const icon = (0, react_jsx_runtime.jsx)(_deepseek_ai_dsh_client_ui_primitives.IconGaugeOutlineRegular, {});'
  if (!pill.includes(oldIcon)) throw new Error('Pinned activity icon changed')
  pill = pill.replace(oldIcon, `const projectedContext = useProjection("kodeContextUsage");
const contextNodes = useChat(snapshot => snapshot.nodes);
const contextKey = useChat(snapshot => snapshot.nodes.values().find(node => node.kind === "kode-context-usage")?.key);
const contextSource = contextNodes.source(contextKey ?? "kode-context-unavailable");
const sampledContext = (0, react.useSyncExternalStore)(contextSource.subscribe, contextSource.getSnapshot)?.data;
const nativeContext = sampledContext && (sampledContext.seq ?? -1) >= (projectedContext?.seq ?? -1) ? sampledContext : projectedContext ?? sampledContext;
const pressure = useProjection("contextPressure");
const used = nativeContext?.awaitingSample ? undefined : nativeContext?.used ?? pressure?.projectedTokens ?? pressure?.pressureTokens;
const total = nativeContext?.total ?? pressure?.contextWindow;
const contextKnown = Number.isFinite(used) && used >= 0 && Number.isFinite(total) && total > 0;
const ratio = contextKnown ? Math.max(0, Math.min(1, used / total)) : 0;
const contextLabel = contextKnown ? used.toLocaleString() + " / " + total.toLocaleString() + " tokens" : nativeContext?.awaitingSample ? t("stats.contextCompacted") : t("stats.contextUnavailable");
const icon = (0, react_jsx_runtime.jsxs)("svg", { width: 18, height: 18, viewBox: "0 0 20 20", fill: "none", "aria-hidden": true, "data-context-ring": true, "data-context-ratio": contextKnown ? ratio : undefined, style: { flexShrink: 0, aspectRatio: "1" }, children: [
 (0, react_jsx_runtime.jsx)("circle", { cx: 10, cy: 10, r: 7.5, stroke: "currentColor", strokeWidth: 2, opacity: .22 }),
 contextKnown && (0, react_jsx_runtime.jsx)("circle", { cx: 10, cy: 10, r: 7.5, stroke: "currentColor", strokeWidth: 2, strokeDasharray: 47.12389, strokeDashoffset: 47.12389 * (1 - ratio), transform: "rotate(-90 10 10)" })
] });`)
  const compact = 'if (mode === "compact") return speed === null ? null : (0, react_jsx_runtime.jsx)(PlainPill, {\n\t\t\t\tstat: "activity",\n\t\t\t\ticon,\n\t\t\t\tlabel: speed\n\t\t\t});'
  if (!pill.includes(compact)) throw new Error('Pinned compact activity contract changed')
  pill = pill.replace(compact, '')
  pill = pill.replace('if (stats.steps === 0) return null;', 'if (stats.steps === 0 && !contextKnown) return null;')
  pill = pill.replace('label: joined$1(counts, speed)', 'label: mode === "compact" && contextKnown ? Math.round(ratio * 100) + "%" : joined$1(counts, speed)')
  pill = pill.replace('if (stats.llmMs <= 0 && stats.toolMs <= 0 && stats.ttftSteps <= 0 && speed === null) return (0, react_jsx_runtime.jsx)(PlainPill, { ...content });', '')
  pill = pill.replace('ariaLabel: speed === null ? counts : `${counts} · ${speed}`,', 'ariaLabel: counts + " · " + contextLabel, titleValue: contextKnown ? Math.round(ratio * 100) + "%" : undefined,')
  pill = pill.replace('"data-session-stats-details": true,\n\t\t\t\t\tchildren: [', '"data-session-stats-details": true,\n\t\t\t\t\tchildren: [(0, react_jsx_runtime.jsx)("dt", { children: t("stats.dialog.context") }), (0, react_jsx_runtime.jsx)("dd", { "data-context-tokens": true, children: contextLabel }),')
  source = source.slice(0, start) + pill + source.slice(end)
}
replace('"stats.dialog.title": "会话统计",', '"stats.contextUnavailable": "Agent 尚未上报上下文用量",\n "stats.contextCompacted": "压缩后用量待更新",\n "stats.dialog.context": "上下文用量（最近上报）",\n "stats.dialog.title": "会话统计",')
replace('"stats.dialog.title": "Session statistics",', '"stats.contextUnavailable": "Context usage not reported by Agent",\n "stats.contextCompacted": "Awaiting usage after compaction",\n "stats.dialog.context": "Context usage (latest report)",\n "stats.dialog.title": "Session statistics",')
replace(`\t\t\tctx.slots.inject("conversation.composer.dock", function* () {
\t\t\t\tyield ctx.slots.register({
\t\t\t\t\tname: "conversation.composer.dock",
\t\t\t\t\tid: "activity",
\t\t\t\t\torder: 0,
\t\t\t\t\tlocale: NS,
\t\t\t\t\tinject: statPillInject
\t\t\t\t}, ActivityPill);
\t\t\t\tyield ctx.slots.register({
\t\t\t\t\tname: "conversation.composer.dock",
\t\t\t\t\tid: "usage",
\t\t\t\t\torder: 1,
\t\t\t\t\tlocale: NS,
\t\t\t\t\tinject: statPillInject
\t\t\t\t}, UsagePill);
\t\t\t});`, `\t\t\tctx.slots.inject("conversation.input.right", function* () {
\t\t\t\tyield ctx.slots.register({
\t\t\t\t\tname: "conversation.input.right",
\t\t\t\t\tid: "activity",
\t\t\t\t\torder: 0,
\t\t\t\t\tlocale: NS,
\t\t\t\t\tinject: statPillInject
\t\t\t\t}, ActivityPill);
\t\t\t});
\t\t\tctx.slots.inject("conversation.composer.dock", function* () {
\t\t\t\tyield ctx.slots.register({
\t\t\t\t\tname: "conversation.composer.dock",
\t\t\t\t\tid: "usage",
\t\t\t\t\torder: 1,
\t\t\t\t\tlocale: NS,
\t\t\t\t\tinject: statPillInject
\t\t\t\t}, UsagePill);
\t\t\t});`)
// Turn rail sits left of the transcript: short marks that fisheye open around
// the pointer, with the preview card to their right.
{
  const head = 'const css$17 = ".eGxaPq_slot{', start = source.indexOf(head), end = source.indexOf('";\n', start)
  if (start < 0 || end < 0 || !source.slice(start, end).includes('right:12px')) throw new Error('Pinned turn rail contract changed')
  const mark = '.eGxaPq_mark', hot = ':is(:hover,:focus-visible)'
  const turnRailCss = `
.eGxaPq_slot{z-index:7;height:0;pointer-events:none;position:absolute;top:0;left:0;right:0;container-type:inline-size}
[data-conversation-scroll] .eGxaPq_slot{position:sticky}
.eGxaPq_frame{--turn-rail-band:calc(var(--dsh-conversation-viewport-height,100dvh) - var(--dsh-composer-height,152px));top:calc(var(--turn-rail-band) / 2);width:34px;max-height:min(max(0px, calc(var(--turn-rail-band) - 64px)), 420px);contain:layout;pointer-events:auto;position:absolute;left:14px;transform:translateY(-50%)}
.eGxaPq_scroller{max-height:inherit;overscroll-behavior:contain;scrollbar-width:none;position:relative;overflow-y:auto}
.eGxaPq_scroller::-webkit-scrollbar{display:none}
.eGxaPq_fadeTop{mask-image:linear-gradient(#0000 0,#000 24px 100%)}
.eGxaPq_fadeBottom{mask-image:linear-gradient(#000 0 calc(100% - 24px),#0000 100%)}
.eGxaPq_fadeTop.eGxaPq_fadeBottom{mask-image:linear-gradient(#0000 0,#000 24px calc(100% - 24px),#0000 100%)}
.eGxaPq_marks{position:relative}
${mark}{cursor:pointer;background:0 0;border:0;height:10px;padding:0;position:absolute;top:0;left:0;right:0}
${mark}:before{content:"";position:absolute;top:50%;left:0;width:30px;height:3px;border-radius:999px;background:color-mix(in srgb,var(--dsw-alias-label-tertiary) 50%,transparent);transform-origin:0;transform:translateY(-50%) scale(.3333,.6667);transition:transform .2s cubic-bezier(.2,.8,.2,1),background-color .16s ease}
${mark}${hot}:before{background:var(--dsw-alias-label-primary);transform:translateY(-50%) scale(1)}
${mark}:has(+ ${mark}${hot}):before,${mark}${hot} + ${mark}:before{background:var(--dsw-alias-label-secondary);transform:translateY(-50%) scale(.6667)}
${mark}:has(+ ${mark} + ${mark}${hot}):before,${mark}${hot} + ${mark} + ${mark}:before{transform:translateY(-50%) scale(.4667,.6667)}
.eGxaPq_markActive:before{background:var(--dsw-alias-label-secondary)}
.eGxaPq_markActive${hot}:before{background:var(--dsw-alias-label-primary)}
.eGxaPq_markUnloaded:before{opacity:.6}
.eGxaPq_markBusy:before{animation:1s ease-in-out infinite eGxaPq_dsh-turn-mark-busy}
${mark}:focus-visible{outline:none}
${mark}:focus-visible:after{content:"";position:absolute;inset:1px 0;border:1px solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));border-radius:4px}
.eGxaPq_preview{top:var(--turn-preview-center);left:36px;box-sizing:border-box;width:min(240px,100cqw - 92px);border:1px solid var(--dsw-alias-border-l2);border-radius:8px;color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-bg-layer-1);box-shadow:var(--dsw-elevation-panel);pointer-events:none;padding:11px 13px;line-height:1.55;text-align:left;transform:translateY(-50%);transition:top .14s cubic-bezier(.2,.8,.2,1);animation:.14s ease-out eGxaPq_dsh-turn-preview-enter;position:absolute}
.eGxaPq_previewPrompt,.eGxaPq_previewResponse{-webkit-box-orient:vertical;display:-webkit-box;overflow:hidden}
.eGxaPq_previewPrompt{color:var(--dsw-alias-label-primary);font-size:13px;font-weight:650;-webkit-line-clamp:1}
.eGxaPq_previewResponse{color:var(--dsw-alias-label-tertiary);font-size:12px;-webkit-line-clamp:3;margin-top:7px}
@keyframes eGxaPq_dsh-turn-preview-enter{0%{opacity:0;transform:translate(-5px,-50%)}to{opacity:1;transform:translate(0,-50%)}}
@keyframes eGxaPq_dsh-turn-mark-busy{0%,to{opacity:1}50%{opacity:.35}}
@container (width<=900px){.eGxaPq_frame{display:none}}
@media (prefers-reduced-motion:reduce){.eGxaPq_frame,.eGxaPq_scroller,${mark}:before,.eGxaPq_markBusy:before,.eGxaPq_preview{scroll-behavior:auto;transition:none;animation:none}}`.trim().replace(/\n/g, '')
  source = source.slice(0, start) + 'const css$17 = ' + JSON.stringify(turnRailCss) + source.slice(end + 1)
}
// Keep adapter styles independent of the upstream plugin's style lifecycle.
source = source.replace(/(const tagId(?:\$\d+)? = "|tag\.dataset\.plugin = ")@deepseek-ai\/dsh-client-ui-chat(?=[/"])/g, '$1@kode/dsh-chat')
const layoutStyle = /(?<=const css\$16 = )"[^\n]+(?=;\n)/.exec(source)
if (!layoutStyle) throw new Error('Pinned Chat stylesheet contract changed')
const layoutStyles = JSON.parse(layoutStyle[0])
  .replace('padding:16px calc(var(--dsh-composer-side-clearance) + 16px)', 'padding:12px calc(var(--dsh-composer-side-clearance,16px) + 16px)')
  .replace('max-width:var(--dsh-chat-content-width);', 'max-width:var(--dsh-chat-content-width,880px);')
  .replaceAll('--dsh-chat-flow-gap:16px', '--dsh-chat-flow-gap:10px')
const layoutOverrides = `
[data-message-attachments] img {
  max-inline-size: 100%;
  max-block-size: 260px;
  object-fit: contain;
}
[data-chat-aside] {
  position: absolute;
  inset: 0 0 auto;
  z-index: 9;
  height: 0;
  pointer-events: none;
  margin-inline-end: calc(-1 * var(--dsh-chat-end-inset, 0px));
  --dsh-chat-aside-gutter: calc(
    var(--dsh-chat-end-inset, 0px) +
    max(0px, (100% - var(--dsh-chat-end-inset, 0px) - var(--dsh-chat-content-width, 100%)) / 2)
  );
}
[data-conversation-scroll] [data-chat-aside] { position: sticky; }
`
source = source.slice(0, layoutStyle.index) + JSON.stringify(layoutStyles + layoutOverrides)
  + source.slice(layoutStyle.index + layoutStyle[0].length)
// A replacement factory may run while its previous stylesheet is still attached.
const layoutStyleMount = `if (typeof document !== "undefined" && document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$16) + "]") === null) {
			const tag = document.createElement("style");
			tag.dataset.plugin = "@kode/dsh-chat";
			tag.dataset.pluginCss = tagId$16;
			tag.textContent = css$16;
			document.head.appendChild(tag);
		}`
replace(layoutStyleMount, `if (typeof document !== "undefined") {
			const tag = document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId$16) + "]") ?? document.createElement("style");
			tag.dataset.plugin = "@kode/dsh-chat";
			tag.dataset.pluginCss = tagId$16;
			tag.textContent = css$16;
			if (!tag.isConnected) document.head.appendChild(tag);
		}`)
replace('className: ChatView_module_css_default.runningWhaleStill,\n\t\t\t\t\twidth: "100%",\n\t\t\t\t\theight: "100%",', 'className: ChatView_module_css_default.runningWhaleStill,\n\t\t\t\t\twidth: 14,\n\t\t\t\t\theight: 14,')
source = source.replace(/\/\/# sourceMappingURL=.*$/m, '').replace(/^[ \t]+$/gm, '').trimEnd() + '\n'
await writeFile(new URL('../packages/chat/client.js', import.meta.url), '// Generated from dsh-client-ui-chat 0.2.1-rc.5 (MIT); run npm run build:chat.\n' + source)
await copyFile(join(dirname(dirname(upstream)), 'LICENSE'), new URL('../packages/chat/LICENSE.upstream', import.meta.url))
