/** Reuse official contiguous process groups; adapt native Agent tool classification only. */
import { createRequire } from 'node:module'
import { readFile, writeFile, copyFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
const resolve = createRequire(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-web-app/package.json')).resolve
const upstream = resolve('@deepseek-ai/dsh-client-ui-chat/client')
let source = await readFile(upstream, 'utf8')
function replace(from, to) { if (!source.includes(from)) throw new Error(`Pinned Chat contract changed: ${from}`); source = source.replace(from, to) }
replace('id: "@deepseek-ai/dsh-client-ui-chat",','id: "@kode/dsh-chat",')
// Stable user-bubble seat for scene-aware appearance without matching generated classes.
replace('className: MessageItem_module_css_default.bubble,', 'className: MessageItem_module_css_default.bubble, "data-kode-user-bubble": true,')
// Keep ui-chat settings compatible with the official chat UI.
replace('function activity(name) {', 'function activity(name) {\n if (name === "kode_native_commandExecution") return "commands";\n if (name === "kode_native_fileChange") return "edit";')
// Keep running commentary visible, but fold completed process even after steering.
replace('const alwaysOpen = liveProcess || interleavedInput || turnProcessAlwaysOpen(routedNode);', 'const alwaysOpen = liveProcess || turnProcessAlwaysOpen(routedNode);')
replace('hasContent: !interleavedInput && (processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning),', 'hasContent: processPresentation?.hasExternalProcess === true || processSpec.inlineReasoning,')
replace('presentation?.turnClosed === false || presentation?.hasInterleavedInput === true || reason', 'presentation?.turnClosed === false || reason')
// The existing Turn control anchors the running timer above this reply.
replace('if (turn?.status !== "closed") return null;', 'if (turn?.status === "open") return (0, react_jsx_runtime.jsx)(RunningStatus, { startTime: turn.start?.time, t }); if (turn?.status !== "closed") return null;')
replace('...running ? [(0, react_jsx_runtime.jsx)(RunningStatus, {', '...running && !entries.some(entry => entry.kind === "node" && nodeStore.get(entry.key)?.kind === "turn-process" && nodeStore.get(entry.key)?.location?.turn?.status === "open") ? [(0, react_jsx_runtime.jsx)(RunningStatus, {')
replace('t("chat.deepDivingFor", { duration: formatRunDuration(Math.max(1e3, now - startTime), t).map((part) => part.text).join("") })', 't("chat.processedFor", { minutes: Math.floor(Math.max(0, now - startTime) / 60000), seconds: Math.floor(Math.max(0, now - startTime) / 1000) % 60 })')
replace('"chat.deepDiving": "深度求索中",', '"chat.processedFor": "已处理 {minutes} 分钟 {seconds} 秒",\n "chat.deepDiving": "处理中",')
replace('"chat.deepDiving": "Deep diving",', '"chat.processedFor": "Working for {minutes} min {seconds} sec",\n "chat.deepDiving": "Working",')
// A focused tool disclosure would otherwise reopen the entire process during
// the native focus-protection pass. Hand focus to its surviving Turn control.
replace('if (turn?.status === "open") return (0, react_jsx_runtime.jsx)(RunningStatus,', `const controlRef = (0, react.useRef)(null);
const previousStatus = (0, react.useRef)(turn?.status);
(0, react.useLayoutEffect)(() => {
  if (previousStatus.current === "open" && turn?.status === "closed" && turn.end?.data.reason.kind === "completed") {
    const focused = document.activeElement?.closest?.("[data-chat-turn]");
    if (focused?.getAttribute("data-chat-turn") === String(node.data.turn) && !["user", "steering"].includes(focused.getAttribute("data-chat-flow-kind"))) controlRef.current?.focus({ preventScroll: true });
    turnProcess.setOpen(false);
  }
  previousStatus.current = turn?.status;
}, [turn?.status, node.data.turn, turnProcess.setOpen]);
if (turn?.status === "open") return (0, react_jsx_runtime.jsx)(RunningStatus,`)
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
source = source.replace(/\/\/# sourceMappingURL=.*$/m, '').replace(/^[ \t]+$/gm, '').trimEnd() + '\n'
await writeFile(new URL('../packages/chat/client.js', import.meta.url), '// Generated from dsh-client-ui-chat 0.2.1-rc.2 (MIT); run npm run build:chat.\n' + source)
await copyFile(join(dirname(dirname(upstream)), 'LICENSE'), new URL('../packages/chat/LICENSE.upstream', import.meta.url))
