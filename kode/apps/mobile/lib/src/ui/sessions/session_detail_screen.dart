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

import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../theme.dart';

String _compactTokens(int value) {
  if (value >= 1000000) {
    return '${(value / 1000000).toStringAsFixed(value >= 10000000 ? 0 : 1)}M';
  }
  if (value >= 1000) {
    return '${(value / 1000).toStringAsFixed(value >= 10000 ? 0 : 1)}k';
  }
  return '$value';
}

String _pathLeaf(String? path) {
  if (path == null || path.trim().isEmpty) return 'workspace unset';
  final normalized = path.replaceAll('\\', '/');
  final parts = normalized.split('/').where((part) => part.isNotEmpty).toList();
  return parts.isEmpty ? normalized : parts.last;
}

String _pathParent(String? path) {
  if (path == null || path.trim().isEmpty) return 'No working directory';
  final normalized = path.replaceAll('\\', '/');
  final index = normalized.lastIndexOf('/');
  if (index <= 0) return normalized;
  return normalized.substring(0, index);
}

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

  /// 当前 PermissionMode(server 推 session.mode_changed 事件 → 这里更新)。
  /// null = 还不知道(刚连上 / 子进程还在 init);UI 显灰色 chip。
  String? _mode;
  bool _modeBusy = false; // POST /mode in flight

  /// 输入框
  final _inputCtrl = TextEditingController();
  bool _sending = false;

  bool _historyLoaded = false;
  int _lastTs = 0;

  /// ListView 控制器,加载完历史 / 收到新事件时自动滚到底
  final _scrollCtrl = ScrollController();

  ProviderSubscription<AsyncValue<Envelope>>? _wsSub;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) async {
      // 注意:**不**在这里清 attention。用户只是点开屏幕看一眼,prompt 还卡着,
      // attention 应该继续提示。session.attention_cleared 事件由 server 推过来
      // (scan_loop 检测到 PTY 屏幕上 prompt 已经消失)时才清。
      await _loadHistory();
      _subscribeLive();
    });
  }

  @override
  void dispose() {
    _wsSub?.close();
    _inputCtrl.dispose();
    _scrollCtrl.dispose();
    super.dispose();
  }

  Future<void> _loadHistory() async {
    final api = ref.read(apiClientProvider);
    if (api == null) return;
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
      debugPrint('[detail #${widget.sessionId}] history failed: $e');
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
          setState(() => _ingest(env));
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
  void _ingest(Envelope env) {
    _lastTs = env.ts > _lastTs ? env.ts : _lastTs;
    switch (env.type) {
      case 'meta':
        _meta = {..._meta, ...env.payload};
        break;
      case 'message':
        _upsert(
          _Item(
            key: 'm-${env.payload['id'] ?? env.ts}',
            type: 'message',
            ts: env.ts,
            payload: env.payload,
          ),
        );
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
      // 重建 byKey 索引
      _byKey.clear();
      for (var k = 0; k < _items.length; k++) {
        _byKey[_items[k].key] = k;
      }
    }
  }

  Future<void> _send() async {
    final text = _inputCtrl.text;
    if (text.isEmpty) return;
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    setState(() => _sending = true);
    try {
      // bridge 会把 text 拆成两部分:`\x1b[200~ <body> \x1b[201~` + `\r`(单独发触发 Ink 提交)。
      // 这里只需要保证:
      //   1. 文本主体里换行用 \n(bridge paste 模式 / Ink 正确解析为多行),不能用 \r —
      //      \r 在 bracketed paste 内部会被 Ink 当成"行尾标记"提前结束输入。
      //   2. 末尾必须有一个换行字符(\n 或 \r),bridge 据此判断"用户要提交"。
      var payload = text.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
      if (!payload.endsWith('\n')) payload = '$payload\n';
      await api.sendInputText(widget.sessionId, payload);
      _inputCtrl.clear();
    } catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(
          context,
        ).showSnackBar(SnackBar(content: Text('send failed: $e')));
      }
    } finally {
      if (mounted) setState(() => _sending = false);
    }
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
    final model = _meta['model'] as String? ?? '';
    final ctxPct = (_meta['context_pct'] as num?)?.toDouble();
    final tokens = (_meta['tokens'] as num?)?.toInt();
    final title = _meta['title'] as String? ?? '';
    final sessionList =
        ref.watch(sessionsProvider).valueOrNull ?? const <SessionDto>[];
    SessionDto? summary;
    for (final item in sessionList) {
      if (item.id == widget.sessionId) {
        summary = item;
        break;
      }
    }
    // 当前 session 是否仍需用户操作(prompt 还没解除)
    final attentionKind = ref.watch(
      sessionAttentionProvider.select((m) => m[widget.sessionId]),
    );

    return Scaffold(
      appBar: AppBar(
        title: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              title.isNotEmpty ? title : 'Session ${widget.sessionId}',
              style: const TextStyle(
                fontSize: 14,
                fontWeight: FontWeight.w900,
                letterSpacing: 1.0,
              ),
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
            ),
            if (summary?.cwd != null && summary!.cwd!.isNotEmpty)
              Text(
                '${_pathLeaf(summary.cwd)} · ${_pathParent(summary.cwd)}',
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(
                  fontSize: 10,
                  color: KillLaColors.textSecondary,
                  fontWeight: FontWeight.w700,
                  fontFamily: 'Menlo',
                ),
              ),
            Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                if (model.isNotEmpty)
                  Text(
                    model,
                    style: const TextStyle(
                      fontSize: 11,
                      color: KillLaColors.textMuted,
                      fontFamily: 'Menlo',
                    ),
                  ),
                if (tokens != null) ...[
                  const SizedBox(width: 8),
                  Text(
                    '${_compactTokens(tokens)} tok',
                    style: const TextStyle(
                      fontSize: 11,
                      color: KillLaColors.textMuted,
                      fontFamily: 'Menlo',
                    ),
                  ),
                ],
                if (ctxPct != null) ...[
                  const SizedBox(width: 8),
                  Text(
                    'ctx ${ctxPct.toStringAsFixed(1)}%',
                    style: TextStyle(
                      fontSize: 11,
                      fontFamily: 'Menlo',
                      fontWeight: FontWeight.w700,
                      color: ctxPct >= 80
                          ? KillLaColors.accent
                          : (ctxPct >= 50
                                ? KillLaColors.busy
                                : KillLaColors.textMuted),
                    ),
                  ),
                ],
              ],
            ),
          ],
        ),
        actions: [
          _ModeChip(mode: _mode, busy: _modeBusy, onPick: _switchMode),
          const SizedBox(width: 8),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            if (attentionKind != null) _AttentionBanner(kind: attentionKind),
            Expanded(
              child: !_historyLoaded
                  ? const Center(child: CircularProgressIndicator())
                  : _items.isEmpty
                  ? const Center(
                      child: Text(
                        'No messages yet — type below to send to the session.',
                        style: TextStyle(color: KillLaColors.textMuted),
                      ),
                    )
                  : ListView.builder(
                      controller: _scrollCtrl,
                      padding: const EdgeInsets.all(12),
                      itemCount: _items.length,
                      itemBuilder: (_, i) => _buildItem(_items[i]),
                    ),
            ),
            const Divider(height: 1),
            _buildInput(),
          ],
        ),
      ),
    );
  }

  Widget _buildItem(_Item item) {
    switch (item.type) {
      case 'message':
        final role = item.payload['role'] as String? ?? '?';
        final text = item.payload['text'] as String? ?? '';
        return _MessageBubble(role: role, text: text);
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

  Widget _buildInput() {
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      child: Row(
        children: [
          Expanded(
            child: TextField(
              controller: _inputCtrl,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(
                hintText: 'Message session…',
                border: OutlineInputBorder(),
                isDense: true,
                contentPadding: EdgeInsets.symmetric(
                  horizontal: 12,
                  vertical: 10,
                ),
              ),
              onSubmitted: (_) => _send(),
            ),
          ),
          const SizedBox(width: 8),
          IconButton.filled(
            icon: _sending
                ? const SizedBox(
                    width: 14,
                    height: 14,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Colors.white,
                    ),
                  )
                : const Icon(Icons.send),
            onPressed: _sending ? null : _send,
          ),
        ],
      ),
    );
  }
}

class _MessageBubble extends StatelessWidget {
  final String role;
  final String text;
  const _MessageBubble({required this.role, required this.text});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final isUser = role == 'user';
    final isSystem = role == 'system';
    final align = isUser ? Alignment.centerRight : Alignment.centerLeft;
    final label = isUser
        ? 'YOU'
        : (isSystem ? 'SYSTEM' : 'AGENT');
    final accentColor = isSystem
        ? colors.onSurfaceVariant
        : (isUser ? colors.primary : colors.secondary);
    final textColor = isSystem
        ? colors.onSurfaceVariant
        : (isUser ? colors.onPrimary : colors.onSurface);
    final bubbleColor = isSystem
        ? colors.surfaceContainerHighest
        : (isUser ? colors.primary : colors.surface);
    final bubbleBorder = isSystem
        ? colors.outline
        : (isUser ? colors.primary : colors.outline);
    final bubbleShadow = isUser
        ? colors.primary.withValues(alpha: 0.18)
        : Colors.black.withValues(alpha: 0.16);
    return Container(
      alignment: align,
      margin: const EdgeInsets.symmetric(vertical: 4),
      child: Container(
        constraints: const BoxConstraints(maxWidth: 540),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
        decoration: BoxDecoration(
          color: bubbleColor,
          gradient: isUser
              ? LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    colors.primary,
                    Color.lerp(colors.primary, colors.onPrimary, 0.12)!,
                  ],
                )
              : null,
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: bubbleBorder),
          boxShadow: [
            BoxShadow(
              color: bubbleShadow,
              blurRadius: 18,
              offset: const Offset(0, 8),
            ),
          ],
        ),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
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
            const SizedBox(height: 4),
            // MarkdownBody(不是 Markdown):后者自带滚动容器,在 ListView 里会冲突。
            // selectable=true 替代原 SelectableText,长按选中复制。
            MarkdownBody(
              data: text,
              selectable: true,
              styleSheet: MarkdownStyleSheet(
                p: TextStyle(
                  fontSize: 14,
                  color: textColor,
                  height: 1.45,
                ),
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
                  borderRadius: BorderRadius.circular(10),
                ),
                blockquoteDecoration: BoxDecoration(
                  color: isUser
                      ? colors.onPrimary.withValues(alpha: 0.14)
                      : colors.onSurface.withValues(alpha: 0.09),
                  border: Border(
                    left: BorderSide(
                      color: isUser
                          ? colors.onPrimary.withValues(alpha: 0.72)
                          : colors.primary,
                      width: 4,
                    ),
                  ),
                  borderRadius: BorderRadius.circular(8),
                ),
                blockquote: TextStyle(
                  color: isUser ? colors.onPrimary : colors.onSurface,
                  fontWeight: FontWeight.w600,
                  height: 1.45,
                ),
                strong: TextStyle(
                  color: textColor,
                  fontWeight: FontWeight.w800,
                ),
                em: TextStyle(
                  color: textColor.withValues(alpha: 0.95),
                ),
                listBullet: TextStyle(color: textColor),
                a: TextStyle(
                  color: isUser ? colors.onPrimary : colors.primary,
                  fontWeight: FontWeight.w700,
                  decoration: TextDecoration.underline,
                  decorationColor: isUser ? colors.onPrimary : colors.primary,
                ),
              ),
            ),
          ],
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
        padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
        margin: const EdgeInsets.symmetric(vertical: 6),
        decoration: BoxDecoration(
          color: color.withValues(alpha: 0.16),
          border: Border.all(color: color, width: 1.5),
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
              Container(
                width: 8,
                height: 8,
                decoration: BoxDecoration(color: color),
              ),
            const SizedBox(width: 6),
            Text(
              label.toUpperCase(),
              style: TextStyle(
                fontSize: 11,
                color: color,
                fontWeight: FontWeight.w900,
                letterSpacing: 0.8,
              ),
            ),
            Icon(Icons.arrow_drop_down, size: 16, color: color),
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
        'default' => 'default',
        'acceptEdits' => 'auto-accept',
        'plan' => 'plan',
        'bypassPermissions' => 'bypass',
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
