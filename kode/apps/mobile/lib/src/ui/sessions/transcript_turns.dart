// Turn structure of a session transcript, modelled on dsh chat
// (integrations/dsh/packages/chat/client.js: ChatGroupSeat, processTitle,
// RunningStatus, turnProcess):
//
// - A turn starts at each user message (including incoming session
//   messages) and runs until the next one.
// - While a turn runs, consecutive tool calls fold into one live group whose
//   title follows the running tool, and a "Working for …" row ticks at the end.
// - Once a turn ends, all of its intermediate work — tool calls, tasks and
//   assistant messages before the final reply — folds into one
//   "Completed in …" row. The final reply stays visible.
// - Questions, plans, session-communication tools and system notices are
//   never folded: they may need an answer or carry routing information.
//
// Pure data: the screen supplies items and renders the entries.
library;

/// One transcript event as the screen stores it.
class TurnInput {
  final String key;
  final String type;
  final int ts;
  final Map<String, dynamic> payload;

  /// Rendered as nothing (e.g. an assistant echo of a session message).
  final bool hidden;
  const TurnInput({
    required this.key,
    required this.type,
    required this.ts,
    required this.payload,
    this.hidden = false,
  });

  bool get isUserMessage => type == 'message' && payload['role'] == 'user';
  bool get isAssistantMessage =>
      type == 'message' && payload['role'] != 'user' && !hidden;
  bool get isPlainTool => type == 'tool_use' && payload['relay_tool'] is! Map;
  bool get isTask => type == 'task_create' || type == 'task_update';
}

sealed class TranscriptEntry {
  String get key;
}

/// A single item rendered by itself.
class ItemEntry extends TranscriptEntry {
  final int index;
  final TurnInput item;

  /// Set on a turn's final reply when the turn ended without a fold row.
  final int? turnDurationMs;
  ItemEntry(this.index, this.item, {this.turnDurationMs});
  @override
  String get key => item.key;
}

/// Consecutive tool calls (and task updates) shown as one collapsible row.
class ToolGroupEntry extends TranscriptEntry {
  final List<int> indices;
  final List<TurnInput> items;

  /// The turn is still running and this is its latest step.
  final bool live;
  ToolGroupEntry(this.indices, this.items, {required this.live});
  @override
  String get key => 'group-${items.first.key}';

  int get toolCount => items.where((i) => i.isPlainTool).length;
  TurnInput? get running =>
      items.lastWhereOrNull((i) => i.isPlainTool && isRunningTool(i.payload));
  bool get anyFailed =>
      items.any((i) => i.isPlainTool && isFailedTool(i.payload));
}

/// A finished turn's intermediate work, folded behind one row.
class TurnFoldEntry extends TranscriptEntry {
  final String id;
  final List<TranscriptEntry> children;
  final int durationMs;
  final int toolCount;
  final int messageCount;
  TurnFoldEntry({
    required this.id,
    required this.children,
    required this.durationMs,
    required this.toolCount,
    required this.messageCount,
  });
  @override
  String get key => 'fold-$id';
}

/// "Working for …" at the end of the running turn.
class RunningEntry extends TranscriptEntry {
  final int startTs;
  RunningEntry(this.startTs);
  @override
  String get key => 'running';
}

bool isRunningTool(Map<String, dynamic> payload) {
  final status = payload['status'] as String? ?? 'running';
  return status == 'running' || status == 'pending' || status == 'in_progress';
}

bool isFailedTool(Map<String, dynamic> payload) {
  final status = payload['status'] as String?;
  return status == 'error' || status == 'failed';
}

/// Splits [items] (sorted by time) into turns and folds them.
/// [running] is whether the session is currently working.
List<TranscriptEntry> buildTranscript(
  List<TurnInput> items, {
  required bool running,
}) {
  final entries = <TranscriptEntry>[];
  var start = 0;
  while (start < items.length) {
    var end = start + 1;
    while (end < items.length && !items[end].isUserMessage) {
      end++;
    }
    // The leading turn before any user message has no starter.
    final hasStarter = items[start].isUserMessage;
    final bodyStart = hasStarter ? start + 1 : start;
    if (hasStarter) entries.add(ItemEntry(start, items[start]));
    final last = end >= items.length;
    final open = last && running;
    _turn(entries, items, bodyStart, end, open: open, starterIndex: start);
    start = end;
  }
  return entries;
}

void _turn(
  List<TranscriptEntry> out,
  List<TurnInput> items,
  int from,
  int to, {
  required bool open,
  required int starterIndex,
}) {
  final startTs = items[starterIndex].ts;
  if (open) {
    out.addAll(_steps(items, from, to, liveTail: true));
    out.add(RunningEntry(startTs));
    return;
  }
  if (from >= to) return;
  var finalReply = -1;
  for (var i = to - 1; i >= from; i--) {
    if (items[i].isAssistantMessage) {
      finalReply = i;
      break;
    }
  }
  final folded = <int>[];
  final pinned = <int>[];
  for (var i = from; i < to; i++) {
    if (i == finalReply || items[i].hidden) continue;
    final item = items[i];
    if (item.isPlainTool || item.isTask || item.isAssistantMessage) {
      folded.add(i);
    } else {
      pinned.add(i);
    }
  }
  var endTs = startTs;
  for (var i = from; i < to; i++) {
    if (items[i].ts > endTs) endTs = items[i].ts;
  }
  final duration = endTs - startTs;
  if (folded.isNotEmpty) {
    out.add(
      TurnFoldEntry(
        id: items[from].key,
        children: _steps(items, from, to, only: folded.toSet()),
        durationMs: duration,
        toolCount: folded.where((i) => items[i].isPlainTool).length,
        messageCount: folded.where((i) => items[i].isAssistantMessage).length,
      ),
    );
  }
  for (final i in pinned) {
    out.add(ItemEntry(i, items[i]));
  }
  if (finalReply >= 0) {
    out.add(
      ItemEntry(
        finalReply,
        items[finalReply],
        turnDurationMs: folded.isEmpty ? duration : null,
      ),
    );
  }
}

/// Items in order with consecutive tools/tasks merged into groups.
List<TranscriptEntry> _steps(
  List<TurnInput> items,
  int from,
  int to, {
  Set<int>? only,
  bool liveTail = false,
}) {
  final out = <TranscriptEntry>[];
  var group = <int>[];
  void flush({required bool live}) {
    if (group.isEmpty) return;
    out.add(
      ToolGroupEntry(List.of(group), [
        for (final i in group) items[i],
      ], live: live),
    );
    group = [];
  }

  for (var i = from; i < to; i++) {
    if (only != null && !only.contains(i)) continue;
    final item = items[i];
    if (item.hidden) continue;
    if (item.isPlainTool || item.isTask) {
      group.add(i);
      continue;
    }
    flush(live: false);
    out.add(ItemEntry(i, item));
  }
  flush(live: liveTail);
  return out;
}

// ---- labels (dsh `message.stepProcess.*`, English dictionary) ----

enum ToolActivity {
  read,
  search,
  edit,
  write,
  commands,
  webSearch,
  webFetch,
  subagents,
  plan,
  questions,
  tools,
}

/// Category of a tool call from its name. Claude/CodeBuddy use
/// `Read`/`Bash`/…, Codex `shell`/`apply_patch`, MCP tools `mcp__srv__name`.
ToolActivity toolActivity(String? rawName) {
  var name = (rawName ?? '').toLowerCase();
  if (name.startsWith('mcp__')) name = name.split('__').last;
  if (const {
    'read',
    'read_file',
    'view',
    'notebookread',
    'ls',
    'list',
  }.contains(name)) {
    return ToolActivity.read;
  }
  if (const {
        'grep',
        'glob',
        'search',
        'find',
        'codebase_search',
      }.contains(name) ||
      name.endsWith('_inspect')) {
    return ToolActivity.search;
  }
  if (const {
    'edit',
    'multiedit',
    'apply_patch',
    'notebookedit',
    'str_replace',
  }.contains(name)) {
    return ToolActivity.edit;
  }
  if (name == 'write' || name == 'write_file' || name == 'create_file') {
    return ToolActivity.write;
  }
  if (const {
        'bash',
        'shell',
        'pwsh',
        'powershell',
        'exec_command',
        'local_shell',
        'write_stdin',
        'bashoutput',
        'killshell',
      }.contains(name) ||
      name.startsWith('terminal')) {
    return ToolActivity.commands;
  }
  if (name == 'websearch' || name == 'web_search') {
    return ToolActivity.webSearch;
  }
  if (name == 'webfetch' || name == 'web_fetch') return ToolActivity.webFetch;
  if (name == 'task' || name == 'agent' || name.startsWith('subagent')) {
    return ToolActivity.subagents;
  }
  if (const {
    'todowrite',
    'todo_write',
    'update_plan',
    'exitplanmode',
  }.contains(name)) {
    return ToolActivity.plan;
  }
  if (name == 'askuserquestion' || name == 'request_user_input') {
    return ToolActivity.questions;
  }
  return ToolActivity.tools;
}

ToolActivity itemActivity(TurnInput item) => item.isTask
    ? ToolActivity.plan
    : toolActivity((item.payload['tool'] ?? item.payload['name']) as String?);

const _liveLabels = {
  ToolActivity.read: 'Reading files',
  ToolActivity.search: 'Searching code',
  ToolActivity.edit: 'Editing files',
  ToolActivity.write: 'Writing files',
  ToolActivity.commands: 'Running commands',
  ToolActivity.webSearch: 'Searching the web',
  ToolActivity.webFetch: 'Visiting web pages',
  ToolActivity.subagents: 'Coordinating subagents',
  ToolActivity.plan: 'Updating the plan',
  ToolActivity.questions: 'Waiting for your action',
  ToolActivity.tools: 'Calling tools',
};

const _doneLabels = {
  ToolActivity.read: 'Read files',
  ToolActivity.search: 'Searched code',
  ToolActivity.edit: 'Edited files',
  ToolActivity.write: 'Wrote files',
  ToolActivity.commands: 'Ran commands',
  ToolActivity.webSearch: 'Searched the web',
  ToolActivity.webFetch: 'Visited web pages',
  ToolActivity.subagents: 'Coordinated subagents',
  ToolActivity.plan: 'Updated the plan',
  ToolActivity.questions: 'Asked questions',
  ToolActivity.tools: 'Called tools',
};

String liveActivityLabel(ToolActivity activity) => _liveLabels[activity]!;

/// Activities ranked by count, ties in first-seen order.
List<ToolActivity> rankedActivities(Iterable<TurnInput> items) {
  final counts = <ToolActivity, int>{};
  for (final item in items) {
    if (!item.isPlainTool && !item.isTask) continue;
    final activity = itemActivity(item);
    counts[activity] = (counts[activity] ?? 0) + 1;
  }
  final order = counts.keys.toList();
  order.sort((a, b) => counts[b]!.compareTo(counts[a]!));
  return order;
}

/// "Read files, searched code and ran commands" — top three, no counts.
String processTitle(List<ToolActivity> ranked) {
  if (ranked.isEmpty) return 'Analysis completed';
  final labels = ranked.take(3).map((a) => _doneLabels[a]!).toList();
  String cont(String s) => s[0].toLowerCase() + s.substring(1);
  if (labels.length == 1) return labels.first;
  if (labels.length == 2) return '${labels[0]} and ${cont(labels[1])}';
  final title = '${labels[0]}, ${cont(labels[1])}, ${cont(labels[2])}';
  return ranked.length > 3 ? '$title, etc.' : title;
}

/// "1m 23s", "12s", "<1s".
String formatDuration(int ms) {
  if (ms < 1000) return '<1s';
  final seconds = ms ~/ 1000;
  if (seconds < 60) return '${seconds}s';
  final minutes = seconds ~/ 60;
  if (minutes < 60) return '${minutes}m ${seconds % 60}s';
  return '${minutes ~/ 60}h ${minutes % 60}m';
}

/// "Completed in 1m 23s · 5 tool calls · 2 messages".
String turnFoldTitle(TurnFoldEntry fold) {
  final parts = <String>['Completed in ${formatDuration(fold.durationMs)}'];
  if (fold.toolCount > 0) {
    parts.add('${fold.toolCount} tool call${fold.toolCount == 1 ? '' : 's'}');
  }
  if (fold.messageCount > 0) {
    parts.add(
      '${fold.messageCount} message${fold.messageCount == 1 ? '' : 's'}',
    );
  }
  return parts.join(' · ');
}

extension _LastWhere<T> on List<T> {
  T? lastWhereOrNull(bool Function(T) test) {
    for (var i = length - 1; i >= 0; i--) {
      if (test(this[i])) return this[i];
    }
    return null;
  }
}
