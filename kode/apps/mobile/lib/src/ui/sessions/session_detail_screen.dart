/// session 详情屏 — 对话流(message + tool_use)。
///
/// 数据源:
///   1. 启动时 /history?from=0 拉历史回放
///   2. WS eventStreamProvider 增量补 message / tool_use / meta
///
/// 当前实现的 9.2.3 第一刀:
///   - 用户 / 助手对话气泡(MarkdownBody 渲染 GFM)
///   - tool_use 折叠卡(展开看 input_summary / output_preview)
///   - meta 不渲染为消息(只在 AppBar 显模型 / token / context %)
///   - ask_user_question / plan_proposed:见到事件先弹 SnackBar 提醒用户(占位)
///   - 输入框:发文本 → POST /input
library;

import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter/services.dart';
import 'package:speech_to_text/speech_to_text.dart';

import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../theme.dart';
import 'backend_identity.dart';
import 'message_markdown.dart';
import 'speech_locale.dart';

String _compactTokens(int value) {
  if (value >= 1000000) {
    return '${(value / 1000000).toStringAsFixed(value >= 10000000 ? 0 : 1)}M';
  }
  if (value >= 1000) {
    return '${(value / 1000).toStringAsFixed(value >= 10000 ? 0 : 1)}k';
  }
  return '$value';
}

bool _showsAgentActivity(String status) =>
    status == 'busy' || status == 'starting';

/// 一条对话气泡或工具调用卡。
class _Item {
  final String key; // 去重 + ListView key
  final String type; // 'message' | 'tool_use'
  final int ts;
  final Map<String, dynamic> payload;
  _Item({
    required this.key,
    required this.type,
    required this.ts,
    required this.payload,
  });
}

class SessionDetailScreen extends ConsumerStatefulWidget {
  final int sessionId;
  const SessionDetailScreen({super.key, required this.sessionId});
  @override
  ConsumerState<SessionDetailScreen> createState() =>
      _SessionDetailScreenState();
}

class _SessionDetailScreenState extends ConsumerState<SessionDetailScreen> {
  /// 顺序的事件列表(message / tool_use 按 ts 升序);meta 不进列表只更新 _meta
  final _items = <_Item>[];

  /// 已见 key 去重(message id / tool_use id;同 tool_use 的 running→ok 会更新而非重复)
  final _byKey = <String, int>{};

  /// AppBar 上显示的 meta(model / total tokens / context_pct)
  Map<String, dynamic> _meta = const {};

  /// WebSocket 收到的即时状态。优先于列表快照，避免详情页晚一拍。
  String? _liveStatus;

  /// 当前 PermissionMode(server 推 session.mode_changed 事件 → 这里更新)。
  /// null = 还不知道(刚连上 / 子进程还在 init);UI 显灰色 chip。
  String? _mode;
  bool _modeBusy = false; // POST /mode in flight

  /// 输入框
  final _inputCtrl = TextEditingController();
  final _inputFocus = FocusNode();
  final _speech = SpeechToText();
  bool _speechInitialized = false;
  bool _speechAvailable = false;
  bool _listening = false;
  String _speechPrefix = '';
  String? _speechError;
  SpeechInputLanguage _speechLanguage = SpeechInputLanguage.mandarin;

  bool _historyLoaded = false;
  String? _historyError;
  int _lastTs = 0;

  /// ListView 控制器,加载完历史 / 收到新事件时自动滚到底
  final _scrollCtrl = ScrollController();

  ProviderSubscription<AsyncValue<Envelope>>? _wsSub;

  void _dismissKeyboard() {
    _inputFocus.unfocus();
    FocusManager.instance.primaryFocus?.unfocus();
  }

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      // 注意:**不**在这里清 attention。用户只是点开屏幕看一眼,prompt 还卡着,
      // attention 应该继续提示。session.attention_cleared 事件由 server 推过来
      // (scan_loop 检测到 PTY 屏幕上 prompt 已经消失)时才清。
      _subscribeLive();
      await _loadHistory();
    });
  }

  @override
  void dispose() {
    _wsSub?.close();
    if (_speechInitialized) unawaited(_speech.cancel());
    _inputCtrl.dispose();
    _inputFocus.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    if (mounted) {
      setState(() {
        _historyLoaded = false;
        _historyError = null;
      });
    }
    try {
      final events = await api.getHistory(
        widget.sessionId,
        fromMs: 0,
        limit: 1000,
      );
      for (final env in events) {
        _ingest(env);
      }
    } catch (e) {
      debugPrint('[detail session ${widget.sessionId}] history failed: $e');
      _historyError = e.toString();
    }
    if (mounted) {
      setState(() => _historyLoaded = true);
      // 历史加载完,自动 scroll 到底(看最新一条)
      _scrollToBottom(animate: false);
    }
  }

  void _scrollToBottom({bool animate = true}) {
    // 等下一帧 ListView 重新 layout 后再滚
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!_scrollCtrl.hasClients) return;
      final target = _scrollCtrl.position.maxScrollExtent;
      if (animate) {
        _scrollCtrl.animateTo(
          target,
          duration: const Duration(milliseconds: 200),
          curve: Curves.easeOut,
        );
      } else {
        _scrollCtrl.jumpTo(target);
      }
    });
  }

  void _subscribeLive() {
    _wsSub = ref.listenManual<AsyncValue<Envelope>>(eventStreamProvider, (
      _,
      ev,
    ) {
      ev.whenData((env) {
        if (env.sessionId != widget.sessionId) return;
        // 注意:不在这里 clear attention。`session.attention_cleared` 事件由
        // providers.dart 里的 SessionAttentionNotifier 监听并清除 — 那是 server
        // 在 PTY 屏幕检测到 prompt 真消失时发出的、唯一可信的"已回应"信号。
        if (mounted) {
          setState(() => _ingest(env, live: true));
          // 仅当用户已在底部 ±60px 时自动跟随;否则保留滚动位置
          if (_scrollCtrl.hasClients) {
            final pos = _scrollCtrl.position;
            if (pos.pixels >= pos.maxScrollExtent - 60) {
              _scrollToBottom();
            }
          }
        }
      });
    });
  }

  /// 把一条 envelope 吸收到本地状态。
  void _ingest(Envelope env, {bool live = false}) {
    _lastTs = env.ts > _lastTs ? env.ts : _lastTs;
    switch (env.type) {
      case 'meta':
        _meta = {..._meta, ...env.payload};
        break;
      case 'message':
        final messageId = env.payload['id'] as String?;
        final messageText = env.payload['text'] as String?;
        if (env.payload['role'] == 'user') {
          ref
              .read(sessionMessageQueueProvider.notifier)
              .markProcessed(
                widget.sessionId,
                semanticMessageId: messageId,
                text: messageText,
              );
        }
        final incoming = _Item(
          key: 'm-${env.payload['id'] ?? env.ts}',
          type: 'message',
          ts: env.ts,
          payload: env.payload,
        );
        if (env.payload['role'] != 'user' ||
            !_replaceOptimisticUserMessage(incoming)) {
          _upsert(incoming);
        }
        break;
      case 'tool_use':
        // 同一 id 的事件 (running → ok/error) 合并
        final id = env.payload['id'] as String? ?? 'tu-${env.ts}';
        final key = 't-$id';
        final existing = _byKey[key];
        if (existing != null) {
          final old = _items[existing];
          // merge:新事件覆盖空字段
          final merged = <String, dynamic>{...old.payload};
          env.payload.forEach((k, v) {
            if (v != null) merged[k] = v;
          });
          _items[existing] = _Item(
            key: old.key,
            type: old.type,
            ts: old.ts,
            payload: merged,
          );
        } else {
          _upsert(
            _Item(key: key, type: 'tool_use', ts: env.ts, payload: env.payload),
          );
        }
        break;
      case 'ask_user_question':
        // payload.question_id 唯一(bridge 形如 "tooluse_xxx-0",含 question 序号),
        // **不能**用 ts:bridge 一行 jsonl 多事件同毫秒 emit,ts 会冲突
        _upsert(
          _Item(
            key: 'ask-${env.payload['question_id'] ?? env.ts}',
            type: 'ask_user_question',
            ts: env.ts,
            payload: env.payload,
          ),
        );
        break;
      case 'plan_proposed':
        _upsert(
          _Item(
            key: 'plan-${env.payload['plan_id'] ?? env.ts}',
            type: 'plan_proposed',
            ts: env.ts,
            payload: env.payload,
          ),
        );
        break;
      case 'task_create':
        // 用 payload.id;同 ts 多个 task 不会冲突
        _upsert(
          _Item(
            key: 'task-${env.payload['id'] ?? env.ts}',
            type: 'task_create',
            ts: env.ts,
            payload: env.payload,
          ),
        );
        break;
      case 'task_update':
        // task_update 不新建 _Item,而是 patch 已有 task_create 卡的 status。
        // 找不到对应 task_create 时(可能因为只看到 update 没看到 create),
        // 退化成插入一个孤立的 task_update 行,起码不丢信息。
        final tid = env.payload['id'];
        final key = 'task-${tid ?? env.ts}';
        final at = _byKey[key];
        if (at != null) {
          final old = _items[at];
          final merged = <String, dynamic>{...old.payload};
          // 仅 status 是稳定 patch 字段;其它(如 subject)不该被 update 覆盖
          if (env.payload['status'] != null) {
            merged['status'] = env.payload['status'];
          }
          _items[at] = _Item(
            key: old.key,
            type: old.type,
            ts: old.ts,
            payload: merged,
          );
        } else {
          _upsert(
            _Item(
              key: 'task-update-${tid ?? env.ts}',
              type: 'task_update',
              ts: env.ts,
              payload: env.payload,
            ),
          );
        }
        break;
      case 'session.exited':
        if (live) _liveStatus = 'exited';
        _upsert(
          _Item(
            key: 'exit-${env.ts}',
            type: 'system',
            ts: env.ts,
            payload: {
              'text': 'session exited (code=${env.payload['exit_code']})',
            },
          ),
        );
        break;
      case 'session.status':
        if (live) {
          final status = env.payload['status'] as String?;
          if (status != null) _liveStatus = status;
        }
        break;
      case 'session.mode_changed':
        // 不进消息流,只更新 AppBar 上的 mode chip
        final m = env.payload['mode'] as String?;
        if (m != null) _mode = m;
        break;
    }
  }

  void _upsert(_Item item) {
    final at = _byKey[item.key];
    if (at != null) {
      _items[at] = item;
    } else {
      // 按 ts 顺序插入(简单线性 — message 量级在百级)
      int i = _items.length;
      while (i > 0 && _items[i - 1].ts > item.ts) {
        i--;
      }
      _items.insert(i, item);
      _reindexItems();
    }
  }

  bool _replaceOptimisticUserMessage(_Item incoming) {
    final incomingText = (incoming.payload['text'] as String? ?? '').trim();
    if (incomingText.isEmpty) return false;
    final optimisticIndex = _items.indexWhere(
      (item) =>
          item.type == 'message' &&
          item.payload['role'] == 'user' &&
          item.payload['optimistic'] == true &&
          (item.payload['text'] as String? ?? '').trim() == incomingText,
    );
    if (optimisticIndex < 0) return false;

    final optimistic = _items[optimisticIndex];
    final outboundId = optimistic.payload['outbound_id'] as String?;
    final reconciled = _Item(
      key: incoming.key,
      type: incoming.type,
      ts: incoming.ts,
      payload: {...incoming.payload, 'outbound_id': ?outboundId},
    );
    final canonicalIndex = _byKey[incoming.key];
    if (canonicalIndex != null && canonicalIndex != optimisticIndex) {
      _items.removeAt(optimisticIndex);
      _reindexItems();
      _upsert(reconciled);
    } else {
      _items[optimisticIndex] = reconciled;
      _reindexItems();
    }
    return true;
  }

  void _reindexItems() {
    _byKey.clear();
    for (var i = 0; i < _items.length; i++) {
      _byKey[_items[i].key] = i;
    }
  }

  Future<void> _send() async {
    if (_listening) await _stopListening();
    final text = _inputCtrl.text.trim();
    if (text.isEmpty) return;

    final outbound = ref
        .read(sessionMessageQueueProvider.notifier)
        .enqueue(sessionId: widget.sessionId, text: text);
    if (outbound == null) return;
    final now = DateTime.now().millisecondsSinceEpoch;
    setState(() {
      _upsert(
        _Item(
          key: 'm-local-${outbound.id}',
          type: 'message',
          ts: now,
          payload: {
            'id': outbound.semanticMessageId,
            'outbound_id': outbound.id,
            'role': 'user',
            'text': text,
            'timestamp_ms': now,
            'optimistic': true,
          },
        ),
      );
    });
    _scrollToBottom();

    // Clear before any asynchronous delivery and dismiss the IME immediately.
    // This prevents iOS composing text from being restored after submit.
    _inputCtrl.clear();
    _dismissKeyboard();
  }

  void _discardOutbound(String itemKey, QueuedSessionMessage message) {
    ref
        .read(sessionMessageQueueProvider.notifier)
        .remove(widget.sessionId, message.id);
    final index = _byKey[itemKey];
    if (index == null) return;
    setState(() {
      _items.removeAt(index);
      _reindexItems();
    });
  }

  Future<void> _toggleSpeech() async {
    if (_listening) {
      await _stopListening();
      return;
    }
    _dismissKeyboard();
    if (mounted) setState(() => _speechError = null);

    try {
      if (!_speechInitialized) {
        final available = await _speech.initialize(
          options: [SpeechToText.androidNoBluetooth],
          onStatus: (status) {
            if (!mounted) return;
            final active = status == SpeechToText.listeningStatus;
            if (_listening != active) setState(() => _listening = active);
          },
          onError: (error) {
            if (!mounted) return;
            setState(() {
              _listening = false;
              _speechError = error.errorMsg.contains('permission')
                  ? 'Microphone or speech access is off. Enable it in Settings.'
                  : 'Voice input stopped. Tap the microphone to try again.';
            });
          },
        );
        if (!mounted) return;
        setState(() {
          _speechInitialized = true;
          _speechAvailable = available;
        });
      }

      if (!_speechAvailable) {
        if (mounted) {
          setState(
            () => _speechError =
                'Speech recognition is not available on this device.',
          );
        }
        return;
      }

      _speechPrefix = _inputCtrl.text.trimRight();
      final availableLocales = await _speech.locales();
      final localeId = resolveSpeechLocaleId(
        availableLocales.map((locale) => locale.localeId),
        _speechLanguage,
      );
      if (localeId == null) {
        if (mounted) {
          setState(
            () => _speechError =
                '${_speechLanguage.localeLabel} speech recognition is not available on this device.',
          );
        }
        return;
      }
      await _speech.listen(
        onResult: (result) {
          if (!mounted) return;
          final words = result.recognizedWords.trim();
          if (words.isEmpty) return;
          final separator = _speechPrefix.isEmpty ? '' : ' ';
          final next = '$_speechPrefix$separator$words';
          _inputCtrl.value = TextEditingValue(
            text: next,
            selection: TextSelection.collapsed(offset: next.length),
          );
        },
        listenOptions: SpeechListenOptions(
          listenMode: ListenMode.dictation,
          localeId: localeId,
          partialResults: true,
          cancelOnError: true,
          autoPunctuation: true,
          pauseFor: const Duration(seconds: 3),
          listenFor: const Duration(minutes: 1),
        ),
      );
      if (mounted) setState(() => _listening = _speech.isListening);
    } catch (_) {
      if (mounted) {
        setState(() {
          _listening = false;
          _speechError = 'Could not start voice input. Tap to try again.';
        });
      }
    }
  }

  Future<void> _stopListening() async {
    if (!_speechInitialized) return;
    await _speech.stop();
    if (mounted) setState(() => _listening = false);
  }

  void _toggleSpeechLanguage() {
    if (_listening) return;
    final next = _speechLanguage.next;
    unawaited(HapticFeedback.selectionClick());
    setState(() {
      _speechLanguage = next;
      _speechError = null;
    });
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(
        SnackBar(
          content: Text('Voice input: ${next.localeLabel}'),
          duration: const Duration(milliseconds: 1200),
        ),
      );
  }

  Future<void> _switchMode(String desired) async {
    if (_modeBusy) return;
    if (_mode == desired) return;
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    setState(() => _modeBusy = true);
    try {
      final reached = await api.setMode(widget.sessionId, desired);
      if (mounted) setState(() => _mode = reached);
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('mode switch failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _modeBusy = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final metaModel = _meta['model'] as String? ?? '';
    final metaCtxPct = (_meta['context_pct'] as num?)?.toDouble();
    final metaTokens = (_meta['tokens'] as num?)?.toInt();
    final metaTitle = _meta['title'] as String? ?? '';
    final sessionList =
        ref.watch(sessionsProvider).valueOrNull ?? const <SessionDto>[];
    SessionDto? summary;
    for (final item in sessionList) {
      if (item.id == widget.sessionId) {
        summary = item;
        break;
      }
    }
    final backendKey =
        summary?.backendKey ?? (_meta['backend_key'] as String?) ?? 'agent';
    final model = metaModel.isNotEmpty ? metaModel : summary?.model ?? '';
    final ctxPct = metaCtxPct ?? summary?.contextPct;
    final tokens = metaTokens ?? summary?.tokens.total ?? 0;
    final summaryTitle = summary?.title ?? '';
    final displayTitle = metaTitle.isNotEmpty
        ? metaTitle
        : (summaryTitle.isNotEmpty ? summaryTitle : 'Untitled session');
    final cwd = summary?.cwd?.trim();
    final sessionStatus = _liveStatus ?? summary?.status ?? 'starting';
    final showAgentActivity = _showsAgentActivity(sessionStatus);
    final queuedMessages = ref.watch(
      sessionMessageQueueProvider.select(
        (queues) => queues[widget.sessionId] ?? const [],
      ),
    );
    final hasHeaderMeta = model.isNotEmpty || tokens > 0 || ctxPct != null;
    // 当前 session 是否仍需用户操作(prompt 还没解除)
    final attentionKind = ref.watch(
      sessionAttentionProvider.select((m) => m[widget.sessionId]),
    );

    return Scaffold(
      appBar: AppBar(
        toolbarHeight: 56,
        titleSpacing: 0,
        title: _SessionHeaderTitle(
          backendKey: backendKey,
          title: displayTitle,
          status: sessionStatus,
          cwd: cwd,
        ),
        actions: [
          _ModeChip(mode: _mode, busy: _modeBusy, onPick: _switchMode),
          const SizedBox(width: 8),
        ],
        bottom: hasHeaderMeta
            ? PreferredSize(
                preferredSize: const Size.fromHeight(28),
                child: _SessionHeaderMeta(
                  model: model,
                  tokens: tokens,
                  contextPct: ctxPct,
                ),
              )
            : null,
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (attentionKind != null) _AttentionBanner(kind: attentionKind),
            Expanded(
              child: !_historyLoaded
                  ? const Center(child: CircularProgressIndicator())
                  : _historyError != null && _items.isEmpty
                  ? Center(
                      child: Padding(
                        padding: const EdgeInsets.all(24),
                        child: Column(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            const Text(
                              'Could not load session history.',
                              style: TextStyle(color: KillLaColors.textMuted),
                            ),
                            const SizedBox(height: 8),
                            Text(
                              _historyError!,
                              textAlign: TextAlign.center,
                              style: const TextStyle(
                                color: KillLaColors.textMuted,
                                fontSize: 12,
                              ),
                            ),
                            const SizedBox(height: 12),
                            OutlinedButton(
                              onPressed: _loadHistory,
                              child: const Text('Retry'),
                            ),
                          ],
                        ),
                      ),
                    )
                  : _items.isEmpty && !showAgentActivity
                  ? const Center(
                      child: Text(
                        'No messages yet — type below to send to the session.',
                        style: TextStyle(color: KillLaColors.textMuted),
                      ),
                    )
                  : ListView.builder(
                      controller: _scrollCtrl,
                      keyboardDismissBehavior:
                          ScrollViewKeyboardDismissBehavior.onDrag,
                      padding: const EdgeInsets.fromLTRB(12, 14, 12, 18),
                      itemCount: _items.length + (showAgentActivity ? 1 : 0),
                      itemBuilder: (_, i) {
                        if (i == _items.length) {
                          return _AgentActivityLine(
                            backendKey: backendKey,
                            status: sessionStatus,
                          );
                        }
                        return _buildItem(
                          _items[i],
                          backendKey: backendKey,
                          outboundMessages: queuedMessages,
                        );
                      },
                    ),
            ),
            _buildInput(
              backendIdentity(backendKey).label,
              sessionStatus: sessionStatus,
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildItem(
    _Item item, {
    required String backendKey,
    required List<QueuedSessionMessage> outboundMessages,
  }) {
    switch (item.type) {
      case 'message':
        final role = item.payload['role'] as String? ?? '?';
        final text = item.payload['text'] as String? ?? '';
        final messageId = item.payload['id'] as String?;
        final outboundId = item.payload['outbound_id'] as String?;
        final outbound = role == 'user'
            ? outboundMessages.where((entry) {
                if (outboundId != null) return entry.id == outboundId;
                if (messageId != null && entry.semanticMessageId == messageId) {
                  return true;
                }
                return entry.status == SessionMessageQueueStatus.processed &&
                    entry.text.trim() == text.trim();
              }).firstOrNull
            : null;
        return _MessageBubble(
          role: role,
          text: text,
          backendKey: backendKey,
          timestamp: (item.payload['timestamp_ms'] as num?)?.toInt(),
          deliveryStatus: outbound?.status,
          onRetry: outbound?.status == SessionMessageQueueStatus.failed
              ? () => ref
                    .read(sessionMessageQueueProvider.notifier)
                    .retry(widget.sessionId, outbound!.id)
              : null,
          onDiscard: outbound?.status == SessionMessageQueueStatus.failed
              ? () => _discardOutbound(item.key, outbound!)
              : null,
        );
      case 'tool_use':
        return _ToolUseCard(payload: item.payload);
      case 'ask_user_question':
        final group = _askGroupFor(item);
        // Only the first event renders the grouped card; later members remain
        // in the event list for history/dedup but do not duplicate the UI.
        if (group.first.key != item.key) return const SizedBox.shrink();
        return _AskQuestionsCard(
          sessionId: widget.sessionId,
          payloads: group.map((entry) => entry.payload).toList(),
        );
      case 'plan_proposed':
        return _PlanCard(sessionId: widget.sessionId, payload: item.payload);
      case 'task_create':
      case 'task_update':
        return _TaskCard(payload: item.payload);
      case 'system':
        return Container(
          margin: const EdgeInsets.symmetric(vertical: 8),
          alignment: Alignment.center,
          child: Text(
            item.payload['text'] as String? ?? '',
            style: const TextStyle(
              color: KillLaColors.textMuted,
              fontSize: 12,
              fontFamily: 'Menlo',
            ),
          ),
        );
    }
    return const SizedBox.shrink();
  }

  List<_Item> _askGroupFor(_Item item) {
    final id = item.payload['question_id'] as String? ?? item.key;
    final base = askQuestionGroupId(id);
    return _items.where((candidate) {
      if (candidate.type != 'ask_user_question') return false;
      final candidateId =
          candidate.payload['question_id'] as String? ?? candidate.key;
      return askQuestionGroupId(candidateId) == base;
    }).toList();
  }

  Widget _buildInput(String backendLabel, {required String sessionStatus}) {
    final colors = Theme.of(context).colorScheme;
    final working = _showsAgentActivity(sessionStatus);
    return ValueListenableBuilder<TextEditingValue>(
      valueListenable: _inputCtrl,
      builder: (context, value, _) {
        final canSend = value.text.trim().isNotEmpty;
        return Container(
          padding: const EdgeInsets.fromLTRB(10, 7, 10, 8),
          decoration: BoxDecoration(
            color: colors.surface,
            border: Border(top: BorderSide(color: colors.outline)),
          ),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            children: [
              if (_listening || _speechError != null)
                _VoiceInputRail(
                  listening: _listening,
                  error: _speechError,
                  languageLabel: _speechLanguage.localeLabel,
                  onDismissError: () => setState(() => _speechError = null),
                ),
              Row(
                crossAxisAlignment: CrossAxisAlignment.end,
                children: [
                  _ComposerIconButton(
                    icon: _listening
                        ? Icons.stop_rounded
                        : Icons.mic_none_rounded,
                    label: _listening
                        ? 'Stop ${_speechLanguage.localeLabel} voice input'
                        : 'Start ${_speechLanguage.localeLabel} voice input',
                    hint: _listening ? null : 'Long press to switch language',
                    badge: _speechLanguage.compactLabel,
                    active: _listening,
                    onPressed: _toggleSpeech,
                    onLongPress: _listening ? null : _toggleSpeechLanguage,
                  ),
                  const SizedBox(width: 7),
                  Expanded(
                    child: TextField(
                      controller: _inputCtrl,
                      focusNode: _inputFocus,
                      onTapOutside: (_) => _dismissKeyboard(),
                      minLines: 1,
                      maxLines: 4,
                      keyboardType: TextInputType.multiline,
                      textInputAction: TextInputAction.newline,
                      decoration: InputDecoration(
                        hintText: _listening
                            ? 'Listening…'
                            : 'Message $backendLabel…',
                        filled: true,
                        fillColor: colors.surfaceContainerHighest,
                        border: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(13),
                          borderSide: BorderSide(color: colors.outline),
                        ),
                        enabledBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(13),
                          borderSide: BorderSide(color: colors.outline),
                        ),
                        focusedBorder: OutlineInputBorder(
                          borderRadius: BorderRadius.circular(13),
                          borderSide: BorderSide(
                            color: colors.primary,
                            width: 1.5,
                          ),
                        ),
                        isDense: true,
                        contentPadding: const EdgeInsets.symmetric(
                          horizontal: 13,
                          vertical: 12,
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 7),
                  Semantics(
                    button: true,
                    label: working
                        ? 'Send message to backend queue'
                        : 'Send message',
                    child: Tooltip(
                      message: working
                          ? 'Send now · backend will queue it'
                          : 'Send message',
                      child: SizedBox(
                        width: 48,
                        height: 46,
                        child: FilledButton(
                          onPressed: canSend ? _send : null,
                          style: FilledButton.styleFrom(
                            elevation: 0,
                            padding: EdgeInsets.zero,
                            shape: RoundedRectangleBorder(
                              borderRadius: BorderRadius.circular(13),
                            ),
                          ),
                          child: Icon(
                            working
                                ? Icons.schedule_send_rounded
                                : Icons.arrow_upward_rounded,
                            size: 23,
                          ),
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}

class _ComposerIconButton extends StatelessWidget {
  final IconData icon;
  final String label;
  final String? hint;
  final String badge;
  final bool active;
  final VoidCallback onPressed;
  final VoidCallback? onLongPress;

  const _ComposerIconButton({
    required this.icon,
    required this.label,
    required this.hint,
    required this.badge,
    required this.active,
    required this.onPressed,
    required this.onLongPress,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      button: true,
      label: label,
      hint: hint,
      child: SizedBox(
        width: 44,
        height: 46,
        child: Material(
          color: active
              ? colors.errorContainer
              : colors.surfaceContainerHighest,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(13),
            side: BorderSide(color: active ? colors.error : colors.outline),
          ),
          clipBehavior: Clip.antiAlias,
          child: InkWell(
            onTap: onPressed,
            onLongPress: onLongPress,
            child: Stack(
              alignment: Alignment.center,
              children: [
                Icon(
                  icon,
                  size: 22,
                  color: active
                      ? colors.onErrorContainer
                      : colors.onSurfaceVariant,
                ),
                Positioned(
                  right: 4,
                  bottom: 3,
                  child: Text(
                    badge,
                    style: TextStyle(
                      color: active ? colors.onErrorContainer : colors.primary,
                      fontSize: 8,
                      fontWeight: FontWeight.w900,
                      letterSpacing: -0.2,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _VoiceInputRail extends StatelessWidget {
  final bool listening;
  final String? error;
  final String languageLabel;
  final VoidCallback onDismissError;

  const _VoiceInputRail({
    required this.listening,
    required this.error,
    required this.languageLabel,
    required this.onDismissError,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final hasError = error != null;
    final accent = hasError ? colors.error : colors.primary;
    return Container(
      margin: const EdgeInsets.only(bottom: 7),
      padding: const EdgeInsets.fromLTRB(10, 7, 6, 7),
      decoration: BoxDecoration(
        color: accent.withValues(alpha: 0.09),
        borderRadius: BorderRadius.circular(11),
        border: Border.all(color: accent.withValues(alpha: 0.28)),
      ),
      child: Row(
        children: [
          Icon(
            hasError ? Icons.mic_off_outlined : Icons.graphic_eq_rounded,
            size: 18,
            color: accent,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              error ??
                  'Listening in $languageLabel · transcript stays editable',
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: hasError ? colors.onSurface : colors.primary,
                fontSize: 12,
                fontWeight: FontWeight.w700,
              ),
            ),
          ),
          if (hasError)
            IconButton(
              onPressed: onDismissError,
              tooltip: 'Dismiss',
              visualDensity: VisualDensity.compact,
              icon: const Icon(Icons.close_rounded, size: 18),
            ),
        ],
      ),
    );
  }
}

class _SessionHeaderTitle extends StatelessWidget {
  final String backendKey;
  final String title;
  final String status;
  final String? cwd;

  const _SessionHeaderTitle({
    required this.backendKey,
    required this.title,
    required this.status,
    required this.cwd,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final statusColor = KillLaColors.statusDot(status);
    return Row(
      children: [
        BackendStatusAvatar(
          backendKey: backendKey,
          statusLabel: sessionStatusLabel(status),
          statusColor: statusColor,
          size: 32,
        ),
        const SizedBox(width: 9),
        Expanded(
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(
                title,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  color: colors.onSurface,
                  fontSize: 15,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 0.15,
                ),
              ),
              const SizedBox(height: 2),
              Row(
                children: [
                  if (cwd != null && cwd!.isNotEmpty) ...[
                    Expanded(
                      child: Tooltip(
                        message: cwd!,
                        child: Row(
                          children: [
                            Icon(
                              Icons.folder_outlined,
                              size: 11,
                              color: colors.onSurfaceVariant,
                            ),
                            const SizedBox(width: 4),
                            Expanded(
                              child: Text(
                                cwd!,
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: TextStyle(
                                  color: colors.onSurfaceVariant,
                                  fontSize: 9.5,
                                  fontFamily: 'Menlo',
                                  fontWeight: FontWeight.w600,
                                ),
                              ),
                            ),
                          ],
                        ),
                      ),
                    ),
                    const SizedBox(width: 8),
                  ] else
                    const Spacer(),
                  Container(
                    width: 5,
                    height: 5,
                    decoration: BoxDecoration(
                      color: statusColor,
                      shape: BoxShape.circle,
                    ),
                  ),
                  const SizedBox(width: 5),
                  Text(
                    sessionStatusLabel(status),
                    style: TextStyle(
                      color: statusColor,
                      fontSize: 9.5,
                      fontWeight: FontWeight.w900,
                      letterSpacing: 0.75,
                    ),
                  ),
                ],
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _SessionHeaderMeta extends StatelessWidget {
  final String model;
  final int tokens;
  final double? contextPct;

  const _SessionHeaderMeta({
    required this.model,
    required this.tokens,
    required this.contextPct,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final contextColor = contextPct == null
        ? colors.onSurfaceVariant
        : contextPct! >= 80
        ? colors.error
        : contextPct! >= 50
        ? KillLaColors.warning
        : colors.onSurfaceVariant;
    return Container(
      height: 28,
      width: double.infinity,
      padding: const EdgeInsets.fromLTRB(12, 0, 10, 0),
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: colors.outline)),
      ),
      child: Row(
        children: [
          if (model.isNotEmpty)
            Expanded(
              flex: 3,
              child: _HeaderMetaValue(
                icon: Icons.memory_rounded,
                text: model,
                tooltip: model,
                color: KillLaColors.warning,
              ),
            ),
          if (tokens > 0) ...[
            const SizedBox(width: 10),
            _HeaderMetaValue(
              icon: Icons.data_usage_rounded,
              text: '${_compactTokens(tokens)} tok',
              color: colors.onSurfaceVariant,
            ),
          ],
          if (contextPct != null) ...[
            const SizedBox(width: 10),
            _HeaderMetaValue(
              icon: Icons.donut_large_rounded,
              text: '${contextPct!.toStringAsFixed(0)}%',
              color: contextColor,
            ),
          ],
        ],
      ),
    );
  }
}

class _HeaderMetaValue extends StatelessWidget {
  final IconData icon;
  final String text;
  final String? tooltip;
  final Color color;

  const _HeaderMetaValue({
    required this.icon,
    required this.text,
    this.tooltip,
    required this.color,
  });

  @override
  Widget build(BuildContext context) {
    final content = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Icon(icon, size: 11, color: color),
        const SizedBox(width: 4),
        Flexible(
          child: Text(
            text,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(
              color: color,
              fontSize: 9.5,
              fontFamily: 'Menlo',
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
      ],
    );
    return tooltip == null
        ? content
        : Tooltip(message: tooltip!, child: content);
  }
}

class _AgentActivityLine extends StatelessWidget {
  final String backendKey;
  final String status;

  const _AgentActivityLine({required this.backendKey, required this.status});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final identity = backendIdentity(backendKey);
    final reduceMotion = MediaQuery.disableAnimationsOf(context);
    final statusColor = KillLaColors.statusDot(status);
    final label = status == 'starting'
        ? 'Starting ${identity.label}…'
        : '${identity.label} is working';
    return Semantics(
      liveRegion: true,
      label: label,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 7),
        child: Row(
          crossAxisAlignment: CrossAxisAlignment.center,
          children: [
            BackendAvatar(backendKey: backendKey, size: 28),
            const SizedBox(width: 8),
            Expanded(
              child: Container(
                constraints: const BoxConstraints(minHeight: 38),
                decoration: BoxDecoration(
                  color: statusColor.withValues(alpha: 0.08),
                  border: Border.all(color: colors.outline),
                  borderRadius: BorderRadius.circular(10),
                ),
                child: Container(
                  padding: const EdgeInsets.symmetric(horizontal: 11),
                  decoration: BoxDecoration(
                    border: Border(
                      left: BorderSide(color: statusColor, width: 2),
                    ),
                  ),
                  child: Row(
                    children: [
                      if (reduceMotion)
                        Container(
                          width: 8,
                          height: 8,
                          decoration: BoxDecoration(
                            color: statusColor,
                            shape: BoxShape.circle,
                          ),
                        )
                      else
                        SizedBox(
                          width: 13,
                          height: 13,
                          child: CircularProgressIndicator(
                            strokeWidth: 2,
                            color: statusColor,
                          ),
                        ),
                      const SizedBox(width: 9),
                      Expanded(
                        child: Text(
                          label,
                          style: TextStyle(
                            color: colors.onSurfaceVariant,
                            fontSize: 12,
                            fontWeight: FontWeight.w700,
                          ),
                        ),
                      ),
                      Text(
                        sessionStatusLabel(status),
                        style: TextStyle(
                          color: statusColor,
                          fontSize: 9,
                          fontFamily: 'Menlo',
                          fontWeight: FontWeight.w900,
                          letterSpacing: 0.8,
                        ),
                      ),
                    ],
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  final String role;
  final String text;
  final String backendKey;
  final int? timestamp;
  final SessionMessageQueueStatus? deliveryStatus;
  final VoidCallback? onRetry;
  final VoidCallback? onDiscard;

  const _MessageBubble({
    required this.role,
    required this.text,
    required this.backendKey,
    required this.timestamp,
    this.deliveryStatus,
    this.onRetry,
    this.onDiscard,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = role == 'user';
    final isSystem = role == 'system';
    final deliveryFailed = deliveryStatus == SessionMessageQueueStatus.failed;
    final identity = backendIdentity(backendKey);
    final timestampLabel = timestamp == null || timestamp! <= 0
        ? ''
        : MaterialLocalizations.of(context).formatTimeOfDay(
            TimeOfDay.fromDateTime(
              DateTime.fromMillisecondsSinceEpoch(timestamp!),
            ),
            alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
          );
    final label = isUser
        ? 'YOU'
        : (isSystem ? 'SYSTEM' : identity.label.toUpperCase());
    final accentColor = isSystem
        ? colors.onSurfaceVariant
        : (isUser
              ? (deliveryFailed
                    ? colors.error
                    : colors.onPrimary.withValues(alpha: 0.78))
              : identity.accent);
    final textColor = isSystem
        ? colors.onSurfaceVariant
        : (isUser
              ? (deliveryFailed ? colors.onSurface : colors.onPrimary)
              : colors.onSurface);
    final bubbleColor = isSystem
        ? colors.surfaceContainerHighest
        : (isUser
              ? (deliveryFailed
                    ? colors.error.withValues(alpha: 0.11)
                    : colors.primary)
              : colors.surface);
    final bubbleBorder = isSystem
        ? colors.outline
        : (isUser
              ? (deliveryFailed ? colors.error : colors.primary)
              : identity.accent.withValues(alpha: 0.28));
    final delivery = switch (deliveryStatus) {
      SessionMessageQueueStatus.submitting ||
      SessionMessageQueueStatus.queued ||
      SessionMessageQueueStatus.sent => (Icons.done_rounded, 'SENT'),
      SessionMessageQueueStatus.processed => (
        Icons.done_all_rounded,
        'PROCESSED',
      ),
      SessionMessageQueueStatus.failed => (
        Icons.error_outline_rounded,
        'NOT SENT',
      ),
      null => null,
    };
    final bubble = Container(
      constraints: const BoxConstraints(maxWidth: 540),
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 9),
      decoration: BoxDecoration(
        color: bubbleColor,
        borderRadius: BorderRadius.circular(14),
        border: Border.all(color: bubbleBorder),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                label,
                style: TextStyle(
                  fontSize: 10,
                  color: accentColor,
                  fontWeight: FontWeight.w900,
                  letterSpacing: 1.2,
                ),
              ),
              if (timestampLabel.isNotEmpty) ...[
                const SizedBox(width: 6),
                Text(
                  '· $timestampLabel',
                  style: TextStyle(
                    fontSize: 10,
                    color: textColor.withValues(alpha: 0.62),
                    fontFamily: 'Menlo',
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
              if (isUser && delivery != null) ...[
                const SizedBox(width: 7),
                Icon(delivery.$1, size: 12, color: accentColor),
                const SizedBox(width: 3),
                Text(
                  delivery.$2,
                  style: TextStyle(
                    fontSize: 9,
                    color: accentColor,
                    fontFamily: 'Menlo',
                    fontWeight: FontWeight.w800,
                    letterSpacing: 0.45,
                  ),
                ),
              ],
            ],
          ),
          const SizedBox(height: 4),
          // MarkdownBody(不是 Markdown):后者自带滚动容器,在 ListView 里会冲突。
          // selectable=true 替代原 SelectableText,长按选中复制。
          MarkdownBody(
            data: normalizeMessageMarkdown(text),
            selectable: true,
            styleSheet: MarkdownStyleSheet(
              p: TextStyle(fontSize: 14, color: textColor, height: 1.45),
              code: TextStyle(
                fontFamily: 'Menlo',
                fontSize: 12,
                color: isUser ? colors.onPrimary : colors.onSurface,
                fontWeight: FontWeight.w700,
                backgroundColor: isUser
                    ? colors.onPrimary.withValues(alpha: 0.12)
                    : colors.onSurface.withValues(alpha: 0.1),
              ),
              codeblockDecoration: BoxDecoration(
                color: isUser
                    ? colors.onPrimary.withValues(alpha: 0.1)
                    : colors.onSurface.withValues(alpha: 0.08),
                border: Border.all(
                  color: isUser
                      ? colors.onPrimary.withValues(alpha: 0.28)
                      : colors.outline,
                ),
                borderRadius: BorderRadius.circular(8),
              ),
              blockquotePadding: const EdgeInsets.only(left: 10),
              blockquoteDecoration: BoxDecoration(
                border: Border(
                  left: BorderSide(
                    color: isUser
                        ? colors.onPrimary.withValues(alpha: 0.62)
                        : identity.accent.withValues(alpha: 0.72),
                    width: 2,
                  ),
                ),
              ),
              blockquote: TextStyle(
                color: isUser ? colors.onPrimary : colors.onSurface,
                fontWeight: FontWeight.w500,
                height: 1.45,
              ),
              strong: TextStyle(color: textColor, fontWeight: FontWeight.w800),
              em: TextStyle(color: textColor.withValues(alpha: 0.95)),
              listBullet: TextStyle(color: textColor),
              a: TextStyle(
                color: isUser ? colors.onPrimary : colors.primary,
                fontWeight: FontWeight.w700,
                decoration: TextDecoration.underline,
                decorationColor: isUser ? colors.onPrimary : colors.primary,
              ),
            ),
          ),
          if (deliveryFailed && onRetry != null && onDiscard != null) ...[
            const SizedBox(height: 7),
            Row(
              mainAxisAlignment: MainAxisAlignment.end,
              children: [
                TextButton(
                  onPressed: onDiscard,
                  style: TextButton.styleFrom(
                    foregroundColor: colors.onSurfaceVariant,
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 8),
                  ),
                  child: const Text('Discard'),
                ),
                const SizedBox(width: 3),
                OutlinedButton.icon(
                  onPressed: onRetry,
                  style: OutlinedButton.styleFrom(
                    foregroundColor: colors.error,
                    side: BorderSide(color: colors.error),
                    visualDensity: VisualDensity.compact,
                    padding: const EdgeInsets.symmetric(horizontal: 9),
                  ),
                  icon: const Icon(Icons.refresh_rounded, size: 15),
                  label: const Text('Retry'),
                ),
              ],
            ),
          ],
        ],
      ),
    );
    final avatar = isUser
        ? const _MessageRoleAvatar.user()
        : isSystem
        ? const _MessageRoleAvatar.system()
        : BackendAvatar(backendKey: backendKey);

    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 5),
      child: Row(
        mainAxisAlignment: isUser
            ? MainAxisAlignment.end
            : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: isUser
            ? [Flexible(child: bubble), const SizedBox(width: 8), avatar]
            : [avatar, const SizedBox(width: 8), Flexible(child: bubble)],
      ),
    );
  }
}

class _MessageRoleAvatar extends StatelessWidget {
  final bool system;

  const _MessageRoleAvatar.user() : system = false;
  const _MessageRoleAvatar.system() : system = true;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final foreground = system ? colors.onSurfaceVariant : colors.primary;
    final label = system ? 'System message' : 'You';
    return Semantics(
      label: label,
      image: true,
      child: Container(
        width: 32,
        height: 32,
        decoration: BoxDecoration(
          color: system
              ? colors.surfaceContainerHighest
              : colors.primary.withValues(alpha: 0.10),
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: foreground.withValues(alpha: 0.34)),
        ),
        child: Icon(
          system ? Icons.settings_rounded : Icons.person_rounded,
          size: 18,
          color: foreground,
        ),
      ),
    );
  }
}

class _ToolUseCard extends StatefulWidget {
  final Map<String, dynamic> payload;
  const _ToolUseCard({required this.payload});
  @override
  State<_ToolUseCard> createState() => _ToolUseCardState();
}

class _ToolUseCardState extends State<_ToolUseCard> {
  bool _open = false;
  @override
  Widget build(BuildContext context) {
    final p = widget.payload;
    final colors = Theme.of(context).colorScheme;
    final tool = p['tool'] as String?;
    final summary = p['input_summary'] as String?;
    final preview = p['output_preview'] as String?;
    final status = p['status'] as String? ?? 'running';

    final dot = KillLaColors.toolStatus(status);

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(10),
        border: Border.all(color: colors.outline),
      ),
      child: Column(
        children: [
          InkWell(
            onTap: () => setState(() => _open = !_open),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                children: [
                  Container(
                    width: 8,
                    height: 8,
                    decoration: BoxDecoration(color: dot),
                  ),
                  const SizedBox(width: 8),
                  Expanded(
                    child: Text(
                      summary ?? (tool != null ? '$tool · $status' : status),
                      style: TextStyle(
                        fontFamily: 'Menlo',
                        fontSize: 12,
                        color: colors.onSurface,
                      ),
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                    ),
                  ),
                  Icon(
                    _open ? Icons.expand_less : Icons.expand_more,
                    size: 18,
                    color: colors.onSurfaceVariant,
                  ),
                ],
              ),
            ),
          ),
          if (_open && preview != null && preview.isNotEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
              child: Container(
                width: double.infinity,
                padding: const EdgeInsets.all(8),
                decoration: BoxDecoration(
                  color: colors.surfaceContainerHighest,
                  border: Border.all(color: colors.outline),
                ),
                child: SelectableText(
                  preview,
                  style: TextStyle(
                    fontFamily: 'Menlo',
                    fontSize: 11,
                    color: colors.onSurfaceVariant,
                  ),
                ),
              ),
            ),
        ],
      ),
    );
  }
}

class _AskQuestionsCard extends ConsumerStatefulWidget {
  final int sessionId;
  final List<Map<String, dynamic>> payloads;
  const _AskQuestionsCard({required this.sessionId, required this.payloads});
  @override
  ConsumerState<_AskQuestionsCard> createState() => _AskQuestionsCardState();
}

class _AskQuestionsCardState extends ConsumerState<_AskQuestionsCard> {
  final Map<String, int> _selections = {};
  final Map<String, TextEditingController> _details = {};
  bool _submitted = false;
  bool _submitting = false;
  String? _error;

  TextEditingController _controller(String id) =>
      _details.putIfAbsent(id, TextEditingController.new);

  @override
  void dispose() {
    for (final controller in _details.values) {
      controller.dispose();
    }
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final header = widget.payloads.isEmpty
        ? null
        : widget.payloads.first['header'] as String?;
    final complete = widget.payloads.every((payload) {
      final id = payload['question_id'] as String? ?? '';
      return _selections.containsKey(id);
    });

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: KillLaColors.bgSecondary,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: KillLaColors.borderStrong),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const Icon(
                Icons.help_outline,
                color: KillLaColors.accent,
                size: 18,
              ),
              const SizedBox(width: 6),
              Text(
                header ?? 'Questions',
                style: const TextStyle(
                  color: KillLaColors.accent,
                  fontWeight: FontWeight.w700,
                  fontSize: 12,
                  letterSpacing: .3,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          const SizedBox(height: 10),
          ...widget.payloads.indexed.map((entry) {
            final (questionIndex, payload) = entry;
            final id = payload['question_id'] as String? ?? 'q_$questionIndex';
            final question = payload['question'] as String? ?? '';
            final options = (payload['options'] as List?) ?? const [];
            return Padding(
              padding: const EdgeInsets.only(bottom: 14),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    '${questionIndex + 1}. $question',
                    style: const TextStyle(
                      fontSize: 14,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(height: 8),
                  ...List.generate(options.length, (i) {
                    final opt = options[i] as Map<String, dynamic>;
                    final label = opt['label'] as String? ?? '?';
                    final desc = opt['description'] as String?;
                    final selected = _selections[id] == i;
                    return Padding(
                      padding: const EdgeInsets.only(bottom: 6),
                      child: InkWell(
                        borderRadius: BorderRadius.circular(9),
                        onTap: _submitted
                            ? null
                            : () => setState(() => _selections[id] = i),
                        child: AnimatedContainer(
                          duration: const Duration(milliseconds: 120),
                          width: double.infinity,
                          padding: const EdgeInsets.symmetric(
                            horizontal: 10,
                            vertical: 9,
                          ),
                          decoration: BoxDecoration(
                            color: selected
                                ? KillLaColors.accent.withValues(alpha: .10)
                                : KillLaColors.bgTertiary,
                            borderRadius: BorderRadius.circular(9),
                            border: Border.all(
                              color: selected
                                  ? KillLaColors.accent
                                  : KillLaColors.border,
                            ),
                          ),
                          child: Row(
                            children: [
                              Icon(
                                selected
                                    ? Icons.radio_button_checked
                                    : Icons.radio_button_off,
                                size: 18,
                                color: selected
                                    ? KillLaColors.accent
                                    : KillLaColors.textMuted,
                              ),
                              const SizedBox(width: 8),
                              Expanded(
                                child: Column(
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Text(
                                      label,
                                      style: const TextStyle(
                                        fontWeight: FontWeight.w600,
                                      ),
                                    ),
                                    if (desc != null)
                                      Text(
                                        desc,
                                        style: const TextStyle(
                                          fontSize: 12,
                                          color: KillLaColors.textSecondary,
                                        ),
                                      ),
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    );
                  }),
                  TextField(
                    controller: _controller(id),
                    enabled: !_submitted,
                    onTapOutside: (_) =>
                        FocusManager.instance.primaryFocus?.unfocus(),
                    minLines: 1,
                    maxLines: 3,
                    decoration: const InputDecoration(
                      hintText: 'Optional details or your own answer',
                      isDense: true,
                    ),
                  ),
                ],
              ),
            );
          }),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 4),
              child: Text(
                _error!,
                style: const TextStyle(color: KillLaColors.danger),
              ),
            ),
          const SizedBox(height: 6),
          Row(
            children: [
              FilledButton(
                onPressed: (!complete || _submitted || _submitting)
                    ? null
                    : _submit,
                child: Text(
                  _submitted
                      ? 'Submitted'
                      : _submitting
                      ? 'Submitting…'
                      : 'Submit all answers',
                ),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _submit() async {
    if (_submitting || _submitted) return;
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    setState(() {
      _submitting = true;
      _error = null;
    });
    try {
      final supplemental = <String>[];
      for (final entry in widget.payloads.indexed) {
        final (index, payload) = entry;
        final qid = payload['question_id'] as String? ?? 'q_$index';
        final selected = _selections[qid];
        if (selected == null) return;
        final options = (payload['options'] as List?) ?? const [];
        final label = selected < options.length
            ? (options[selected] as Map<String, dynamic>)['label'] as String? ??
                  'option ${selected + 1}'
            : 'option ${selected + 1}';
        final details = _controller(qid).text.trim();
        await api.postAnswer(
          widget.sessionId,
          qid,
          selected,
          submit: index == widget.payloads.length - 1,
        );
        if (details.isNotEmpty) {
          supplemental.add(
            '- ${payload['question'] ?? qid}\n  Selected: $label\n  User details: $details',
          );
        }
      }
      if (supplemental.isNotEmpty) {
        await api.sendInputText(
          widget.sessionId,
          'Additional context for my AskUserQuestion answers:\n\n${supplemental.join('\n\n')}\n',
        );
      }
      // 乐观清 attention — server 的 scan_loop 在 ~200-400ms 后才会推 attention_cleared,
      // 这一段时间避免 list 上仍闪烁让用户困惑。如果 server 没真清掉(子进程又弹了
      // 新 prompt),下一次扫描会自动重新点亮。
      ref
          .read(sessionAttentionProvider.notifier)
          .clearOptimistic(widget.sessionId);
      setState(() => _submitted = true);
    } catch (e) {
      setState(() => _error = '$e');
    } finally {
      if (mounted) setState(() => _submitting = false);
    }
  }
}

class _PlanCard extends ConsumerStatefulWidget {
  final int sessionId;
  final Map<String, dynamic> payload;
  const _PlanCard({required this.sessionId, required this.payload});
  @override
  ConsumerState<_PlanCard> createState() => _PlanCardState();
}

class _PlanCardState extends ConsumerState<_PlanCard> {
  bool? _accepted;
  String? _error;

  @override
  Widget build(BuildContext context) {
    final planMd = widget.payload['plan_md'] as String? ?? '';
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(12),
      decoration: BoxDecoration(
        color: KillLaColors.warning.withValues(alpha: 0.10),
        border: const Border(
          left: BorderSide(color: KillLaColors.warning, width: 4),
          top: BorderSide(color: KillLaColors.warning),
          right: BorderSide(color: KillLaColors.warning),
          bottom: BorderSide(color: KillLaColors.warning),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          const Row(
            children: [
              Icon(Icons.list_alt, color: KillLaColors.warning, size: 18),
              SizedBox(width: 6),
              Text(
                'PLAN PROPOSED',
                style: TextStyle(
                  color: KillLaColors.warning,
                  fontWeight: FontWeight.w900,
                  fontSize: 12,
                  letterSpacing: 1.2,
                ),
              ),
            ],
          ),
          const SizedBox(height: 8),
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: KillLaColors.bgPrimary,
              border: Border.all(color: KillLaColors.border),
            ),
            child: MarkdownBody(
              data: planMd,
              selectable: true,
              styleSheet: MarkdownStyleSheet(
                p: const TextStyle(
                  fontSize: 13,
                  color: KillLaColors.textPrimary,
                ),
                code: const TextStyle(
                  fontFamily: 'Menlo',
                  fontSize: 12,
                  color: KillLaColors.warning,
                  backgroundColor: Color(0x33000000),
                ),
                codeblockDecoration: BoxDecoration(
                  color: KillLaColors.bgSecondary,
                  border: Border.all(color: KillLaColors.border),
                ),
                listBullet: const TextStyle(
                  fontSize: 13,
                  color: KillLaColors.textPrimary,
                ),
                checkbox: const TextStyle(
                  fontSize: 13,
                  color: KillLaColors.textPrimary,
                ),
              ),
            ),
          ),
          if (_error != null)
            Padding(
              padding: const EdgeInsets.only(top: 6),
              child: Text(
                _error!,
                style: const TextStyle(color: KillLaColors.danger),
              ),
            ),
          const SizedBox(height: 8),
          Row(
            children: [
              FilledButton(
                onPressed: _accepted != null ? null : () => _respond(true),
                child: Text(_accepted == true ? '✓ ACCEPTED' : 'ACCEPT'),
              ),
              const SizedBox(width: 8),
              OutlinedButton(
                onPressed: _accepted != null ? null : () => _respond(false),
                child: Text(_accepted == false ? '✗ REJECTED' : 'REJECT'),
              ),
            ],
          ),
        ],
      ),
    );
  }

  Future<void> _respond(bool accept) async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    try {
      final pid = widget.payload['plan_id'] as String? ?? '?';
      await api.postPlanResponse(widget.sessionId, pid, accept);
      // 乐观清 attention(server scan_loop 也会推 attention_cleared 兜底)
      ref
          .read(sessionAttentionProvider.notifier)
          .clearOptimistic(widget.sessionId);
      setState(() => _accepted = accept);
    } catch (e) {
      setState(() => _error = '$e');
    }
  }
}

/// 任务卡 —— task_create 创建时显示 subject/description,task_update 来时
/// 通过外层 _ingest 的 patch 更新 status(本 widget 直接读 payload['status'])。
class _TaskCard extends StatelessWidget {
  final Map<String, dynamic> payload;
  const _TaskCard({required this.payload});

  @override
  Widget build(BuildContext context) {
    final subject = payload['subject'] as String? ?? '';
    final description = payload['description'] as String?;
    final status = payload['status'] as String? ?? 'pending';

    final (color, icon, label) = KillLaColors.taskStyle(status);

    return Container(
      margin: const EdgeInsets.symmetric(vertical: 4),
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.08),
        border: Border(
          left: BorderSide(color: color, width: 3),
          top: BorderSide(color: KillLaColors.border),
          right: BorderSide(color: KillLaColors.border),
          bottom: BorderSide(color: KillLaColors.border),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Icon(icon, size: 14, color: color),
              const SizedBox(width: 6),
              Text(
                label.toUpperCase(),
                style: TextStyle(
                  color: color,
                  fontSize: 11,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.8,
                ),
              ),
              const SizedBox(width: 8),
              Expanded(
                child: Text(
                  subject.isEmpty ? '(no subject)' : subject,
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                    color: KillLaColors.textPrimary,
                  ),
                  maxLines: 2,
                  overflow: TextOverflow.ellipsis,
                ),
              ),
            ],
          ),
          if (description != null && description.isNotEmpty) ...[
            const SizedBox(height: 4),
            Padding(
              padding: const EdgeInsets.only(left: 20),
              child: Text(
                description,
                style: const TextStyle(
                  fontSize: 11,
                  color: KillLaColors.textMuted,
                ),
              ),
            ),
          ],
        ],
      ),
    );
  }
}

/// AppBar 上的 mode 切换 chip。
/// - mode=null:显灰色 "—"
/// - mode=default/acceptEdits/plan/bypassPermissions:用对应颜色 + 简短文字
/// - 点击弹 4 个选项的菜单,选中调用 onPick(mode)
class _ModeChip extends StatelessWidget {
  final String? mode;
  final bool busy;
  final ValueChanged<String> onPick;
  const _ModeChip({
    required this.mode,
    required this.busy,
    required this.onPick,
  });

  @override
  Widget build(BuildContext context) {
    final (color, label) = _styleFor(mode);
    return PopupMenuButton<String>(
      tooltip: 'Permission mode',
      borderRadius: BorderRadius.circular(8),
      enabled: !busy,
      onSelected: onPick,
      itemBuilder: (_) => const [
        PopupMenuItem(
          value: 'default',
          child: _ModeMenuItem(label: 'Default', sub: '每个工具调用都要批准'),
        ),
        PopupMenuItem(
          value: 'acceptEdits',
          child: _ModeMenuItem(
            label: 'Auto-accept edits',
            sub: '自动批准 file/edit',
          ),
        ),
        PopupMenuItem(
          value: 'plan',
          child: _ModeMenuItem(label: 'Plan', sub: '只规划不执行'),
        ),
        PopupMenuItem(
          value: 'bypassPermissions',
          child: _ModeMenuItem(label: 'Bypass permissions', sub: '⚠️ 全部跳过批准'),
        ),
      ],
      child: Container(
        height: 30,
        padding: const EdgeInsets.symmetric(horizontal: 7),
        margin: const EdgeInsets.symmetric(vertical: 13),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.10),
          border: Border.all(color: color.withValues(alpha: 0.48)),
          borderRadius: BorderRadius.circular(9),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            if (busy)
              SizedBox(
                width: 10,
                height: 10,
                child: CircularProgressIndicator(
                  strokeWidth: 1.5,
                  color: color,
                ),
              )
            else
              Icon(Icons.shield_outlined, size: 13, color: color),
            const SizedBox(width: 4),
            Text(
              label,
              style: TextStyle(
                fontSize: 9.5,
                color: color,
                fontWeight: FontWeight.w900,
                letterSpacing: 0.25,
              ),
            ),
          ],
        ),
      ),
    );
  }

  (Color, String) _styleFor(String? m) {
    final c = KillLaColors.modeColor(m);
    return (
      c,
      switch (m) {
        'default' => 'Default',
        'acceptEdits' => 'Auto',
        'plan' => 'Plan',
        'bypassPermissions' => 'Bypass',
        _ => '—',
      },
    );
  }
}

class _ModeMenuItem extends StatelessWidget {
  final String label;
  final String sub;
  const _ModeMenuItem({required this.label, required this.sub});
  @override
  Widget build(BuildContext context) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Text(
          label,
          style: const TextStyle(
            fontWeight: FontWeight.w700,
            color: KillLaColors.textPrimary,
          ),
        ),
        Text(
          sub,
          style: const TextStyle(fontSize: 11, color: KillLaColors.textMuted),
        ),
      ],
    );
  }
}

/// 详情屏顶部 attention banner — 当前 session prompt 还卡着没解除时显示。
/// 点 Submit 后 _submit / _respond 已乐观清掉,server scan_loop 兜底确认。
/// 用户被引导滚到下面找 ask/plan 卡片回答。
class _AttentionBanner extends StatefulWidget {
  final String kind; // 'ask' | 'plan'
  const _AttentionBanner({required this.kind});
  @override
  State<_AttentionBanner> createState() => _AttentionBannerState();
}

class _AttentionBannerState extends State<_AttentionBanner>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl;
  @override
  void initState() {
    super.initState();
    _ctrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 1100),
    )..repeat(reverse: true);
  }

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final isPlan = widget.kind == 'plan';
    final color = KillLaColors.attention(widget.kind);
    final reduce = MediaQuery.disableAnimationsOf(context);
    final badge = Container(
      width: 24,
      height: 24,
      alignment: Alignment.center,
      decoration: BoxDecoration(
        color: color,
        borderRadius: BorderRadius.circular(7),
        border: Border.all(color: KillLaColors.borderStrong),
      ),
      child: Text(
        isPlan ? '!' : '?',
        style: const TextStyle(
          color: Colors.white,
          fontSize: 14,
          fontWeight: FontWeight.w900,
        ),
      ),
    );
    return Container(
      width: double.infinity,
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 10),
      decoration: BoxDecoration(
        color: color.withValues(alpha: 0.16),
        border: Border(
          top: BorderSide(color: color, width: 2),
          bottom: BorderSide(color: color, width: 2),
        ),
      ),
      child: Row(
        children: [
          if (reduce)
            badge
          else
            ScaleTransition(
              scale: Tween(
                begin: 1.0,
                end: 1.20,
              ).chain(CurveTween(curve: Curves.easeInOut)).animate(_ctrl),
              child: badge,
            ),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  isPlan
                      ? 'PLAN AWAITING DECISION'
                      : 'WAITING FOR YOUR RESPONSE',
                  style: TextStyle(
                    color: color,
                    fontSize: 13,
                    fontWeight: FontWeight.w900,
                    letterSpacing: 1.2,
                  ),
                ),
                Text(
                  isPlan
                      ? 'Scroll down and Accept or Reject the plan to continue.'
                      : 'Scroll down and answer the prompt to continue.',
                  style: TextStyle(
                    color: color.withValues(alpha: 0.85),
                    fontSize: 11,
                  ),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }
}
