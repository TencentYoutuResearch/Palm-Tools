// Scoped native text-composer adapter; compiled only into @kode/dsh-composer.
// No Session, uploads, microphone, command registry or authority is synthesized.
// Optional seats mirror the native composer stack: the hero workspace row above
// the card, attachments inside it, and model/activity before send. Callers fill
// them with native slot entries; this adapter only supplies native placement.
function PortableTextComposer(props) {
  if (!props.scopeKey || typeof props.value !== 'string' || !props.ariaLabel)
    throw Error('PortableTextComposer requires scopeKey, string value and ariaLabel');
  return react.createElement(PortableTextComposerInstance, { ...props, key: props.scopeKey });
}
const portableCss = (name) => typeof name === 'undefined' ? {} : name;
function PortableTextComposerInstance(props) {
  const latest = react.useRef(props); latest.current = props;
  const scrollRef = react.useRef(null), busy = react.useRef(false), alive = react.useRef(true), fileRef = react.useRef(null);
  const [sending, setSending] = react.useState(false), [error, setError] = react.useState(''), [activity, setActivity] = react.useState(false);
  const suppress = react.useRef(false), runtimeRef = react.useRef(null);
  const accepted = react.useRef(props.value), restoring = react.useRef(false), composing = react.useRef(false), revision = react.useRef(0);
  const limit = () => Math.min(65536, Math.max(1, Number.isSafeInteger(latest.current.maxLength) ? latest.current.maxLength : 65536));
  const lengthError = () => latest.current.lengthLimitLabel || `内容超过 ${limit()} 个字符。本次超限输入未加入草稿，原草稿已保留。请缩短后重试。`;
  const attachmentItems = () => latest.current.attachments?.items ?? [];
  function syncDraft() {
      const runtime = runtimeRef.current; runtime.refreshProjection();
      const text = runtime.projection.clipboardText;
      if (suppress.current || composing.current || runtime.editor.isComposing()) return;
      if (text.length > limit()) {
        setError(lengthError());
        if (!restoring.current) {
          restoring.current = true;
          // Never nest a Lexical update inside its committed update listener.
          // Reject the whole edit, not a truncated prefix, and keep durable text.
          queueMicrotask(() => {
            if (!alive.current) { restoring.current = false; return; }
            suppress.current = true;
            try { runtime.setDraft(accepted.current); runtime.refreshProjection(); runtime.clearHistory(); }
            finally { suppress.current = false; restoring.current = false; }
          });
        }
      } else {
        if (text !== latest.current.value) { revision.current++; setError(''); latest.current.onChange(text); }
        accepted.current = text;
      }

  }
  if (!runtimeRef.current) runtimeRef.current = new DraftEditorRuntime({
    onUpdate: syncDraft, openReference: () => false, lexicon: () => new Map(), resolveLexicon: () => undefined
  });
  const runtime = runtimeRef.current;
  const editable = () => !latest.current.disabled && !latest.current.readOnly && !latest.current.editingDisabled && !busy.current;
  // allowEmpty: the caller's send is an explicit action that does not need typed text.
  const hasContent = () => !!latest.current.allowEmpty || !!runtime.projection.clipboardText.trim() || attachmentItems().length > 0;
  const canSubmit = () => !latest.current.sendDisabled && !composing.current && !runtime.editor.isComposing() && !restoring.current && !busy.current && !latest.current.disabled && !latest.current.readOnly && runtime.projection.clipboardText.length <= limit() && hasContent();
  const submit = async () => {
    if (runtime.projection.clipboardText.length > limit()) { setError(lengthError()); return; }
    if (!canSubmit()) return;
    busy.current = true; setSending(true); setError('');
    const request = Object.freeze({ scopeKey: latest.current.scopeKey, text: runtime.projection.clipboardText,
      ...(latest.current.attachments ? { attachmentIds: Object.freeze(attachmentItems().map(item => item.id)) } : {}) });
    try { await latest.current.onSubmit(request); }
    catch (e) { if (alive.current) setError(latest.current.failureLabel || '发送尚未确认，请重试。'); }
    finally { busy.current = false; if (alive.current) setSending(false); }
  };
  // Files are only handed to a caller that declared it can stage them; nothing is uploaded here.
  const intakeFiles = files => {
    const spec = latest.current.attachments, list = Array.from(files ?? []);
    if (spec && !list.length) return;
    if (!spec || !spec.canAccept || !editable()) { setError(spec?.unsupportedLabel || latest.current.unsupportedFilesLabel || '此会话暂不支持附件，文件未上传。'); return; }
    setError(''); spec.onAdd(list);
  };
  // The native voice activity contract. A transcript is inserted into the editable
  // draft only when the draft has not changed since capture; otherwise the native
  // control keeps the transcript for the user to place manually.
  const inputActions = react.useRef(null);
  if (!inputActions.current) inputActions.current = Object.freeze({
    captureInsertion: () => Object.freeze({ scopeKey: latest.current.scopeKey, revision: revision.current, text: runtime.projection.clipboardText }),
    insertText: (text, span) => {
      if (typeof text !== 'string' || !text || !alive.current || !editable()) return false;
      if (!span || span.scopeKey !== latest.current.scopeKey || span.revision !== revision.current || span.text !== runtime.projection.clipboardText) return false;
      const next = span.text + (span.text && !/\s$/.test(span.text) ? ' ' : '') + text;
      if (next.length > limit()) { setError(lengthError()); return false; }
      runtime.setDraft(next); runtime.refreshProjection(); syncDraft();
      return runtime.projection.clipboardText === next;
    },
  });
  react.useLayoutEffect(() => {
    alive.current = true;
    const unregister = runtime.register();
    // A composition is one edit: never persist its intermediate phonetic text
    // or roll back the editor while the input method still owns the selection.
    const compositionStart = () => { composing.current = true; };
    const compositionEnd = () => queueMicrotask(() => {
      if (!alive.current) return;
      composing.current = false;
      syncDraft();
    });
    const unregisterComposition = runtime.editor.registerRootListener((root, previous) => {
      previous?.removeEventListener('compositionstart', compositionStart);
      previous?.removeEventListener('compositionend', compositionEnd);
      root?.addEventListener('compositionstart', compositionStart);
      root?.addEventListener('compositionend', compositionEnd);
    });
    const keys = registerComposerKeymap(runtime.editor, {
      arbitrate: () => 'pass', dismissPopup() {}, space: () => false,
      canSubmit, submit, pasteText: text => { if (editable()) runtime.paste(text); },
      intakeFiles
    });
    return () => { alive.current = false; unregisterComposition(); keys(); unregister(); };
  }, [runtime]);
  react.useLayoutEffect(() => {
    accepted.current = props.value;
    if (props.value.length > limit()) setError(`当前内容超过 ${limit()} 个字符，尚未保存，不能发送。请缩短后重试。`);
    if (props.value !== runtime.projection.clipboardText) {
      revision.current++;
      suppress.current = true;
      try { runtime.setDraft(props.value); runtime.refreshProjection(); runtime.clearHistory(); }
      finally { suppress.current = false; }
    }
  }, [props.value, runtime]);
  const disabled = !!props.disabled || !!props.readOnly || sending;
  const css = InputBar_module_css_default, rootCss = portableCss(typeof ConversationRoot_module_css_default === 'undefined' ? undefined : ConversationRoot_module_css_default);
  const spec = props.attachments, items = spec?.items ?? [];
  const locked = disabled || !!props.editingDisabled;
  const onActiveChange = react.useRef(null);
  if (!onActiveChange.current) onActiveChange.current = value => { if (alive.current) setActivity(!!value); };
  const card = react.createElement('div', {className: css.root, 'data-portable-composer': props.scopeKey,
    onDropCapture: e => { if (e.dataTransfer?.files.length) { e.preventDefault(); intakeFiles(e.dataTransfer.files); } }},
    react.createElement('div', {className: css.card},
      props.accessory ? react.createElement('div', {className: css.accessory}, props.accessory) : null,
      spec && props.renderAttachments ? props.renderAttachments({ attachments: items, canAcceptDrop: !!spec.canAccept && !locked,
        onAddFiles: intakeFiles, onRemoveAttachment: id => { if (!locked) spec.onRemove(id); }, uploads: spec.uploads ?? {},
        onRetryFile: id => { if (!locked) spec.onRetry?.(id); }, ...(spec.limits ? { dropLimits: spec.limits } : {}) }) : null,
      react.createElement(DraftEditor, {classNames:css,editor:runtime.editor,scrollRef,editable:!disabled && !props.editingDisabled,
        editorDisabled:disabled || !!props.editingDisabled,phase:'idle',placeholderText:props.placeholder || '',ariaLabel:props.ariaLabel,
        workspaceTrigger:false,workspacePickerOpen:false,hint:null,showPlaceholder:!props.value && !items.length}),
      react.createElement('div', {className:css.row},
        react.createElement('div', {className:css.tools, hidden: activity},
          spec ? react.createElement('button', {type:'button',className:css.add,'aria-label':spec.addLabel || '添加图片',
            title: spec.canAccept ? undefined : spec.unsupportedLabel, 'aria-disabled': !spec.canAccept || locked || undefined,
            onClick: () => { if (spec.canAccept && !locked) fileRef.current?.click(); else setError(spec.unsupportedLabel || '此会话暂不支持附件，文件未上传。'); }},
            typeof _deepseek_ai_dsh_client_ui_primitives === 'undefined' ? '+' : react.createElement(_deepseek_ai_dsh_client_ui_primitives.IconPlusOutlineMedium, { size: 14 })) : null,
          spec ? react.createElement('input', {ref:fileRef,type:'file',multiple:true,hidden:true,accept:spec.accept || 'image/*',
            onChange: e => { const files = e.target.files; intakeFiles(files); e.target.value = ''; }}) : null,
          props.tools || null),
        react.createElement('div', {className: activity && css.trailingActive ? css.trailing + ' ' + css.trailingActive : css.trailing},
          react.createElement('div', {className: css.standardControls, hidden: activity}, props.trailing || null),
          props.renderActivity ? react.createElement('div', {className: activity ? css.activityExpanded : css.activity},
            props.renderActivity({ inputActions: inputActions.current, locked, onActiveChange: onActiveChange.current })) : null,
          react.createElement('button', {type:'button',className:css.primary,'aria-label':props.sendLabel || '发送',
            disabled:disabled || !!props.sendDisabled || props.value.length > limit() || (!props.allowEmpty && !props.value.trim() && !items.length),onClick:submit},
            react.createElement('svg', {viewBox:'0 0 16 16',width:16,height:16,'aria-hidden':true},
              react.createElement('path',{d:'M8.3125 0.980183C8.66767 1.0531 8.97902 1.20418 9.2627 1.43233C9.48724 1.61297 9.73029 1.85793 9.97949 2.10714L14.707 6.83468L13.293 8.24874L9 3.95577V15.0417H7V3.95577L2.70703 8.24874L1.29297 6.83468L6.02051 2.10714C6.26971 1.85793 6.51277 1.61297 6.7373 1.43233C6.97662 1.23986 7.28445 1.04402 7.6875 0.980183C7.8973 0.947006 8.1031 0.95516 8.3125 0.980183Z',fill:'currentColor'})))))),
    error ? react.createElement('div',{role:'alert'},error) : null);
  if (!props.header) return card;
  // Native hero stack: workspace/host/Agent row directly above the composer card.
  const chip = typeof WorkspaceChip === 'undefined' ? null : WorkspaceChip;
  return react.createElement('div', {className: [rootCss.composerStack, rootCss.composerHero].filter(Boolean).join(' '), 'data-portable-composer-stack': props.scopeKey},
    react.createElement('div', {className: rootCss.heroWorkspaceRow, 'data-portable-composer-header': true}, props.header({ WorkspaceChip: chip })),
    card);
}
exports.PortableTextComposer = PortableTextComposer;
exports.portableComposerCapabilities = Object.freeze({version:1,text:true,attachments:true,voice:true,header:true,trailing:true,activity:true,allowEmpty:true,sendDisabled:true});

// Every DSH client graph row is activated by Cordis, including component libraries.
// This entry intentionally registers no services, slots, Sessions or Conversation.
function applyPortableComposer() {}
exports.apply = applyPortableComposer;
