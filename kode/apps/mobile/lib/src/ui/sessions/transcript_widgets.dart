// dsh-style transcript rows: tool groups, folded turns and the running clock.
// Layout and copy follow integrations/dsh/packages/chat (ChatGroupSeat,
// RunningStatus, TurnTail); grouping lives in transcript_turns.dart.
import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import 'transcript_turns.dart';

IconData activityIcon(ToolActivity activity) => switch (activity) {
  ToolActivity.read => Icons.description_outlined,
  ToolActivity.search => Icons.search_rounded,
  ToolActivity.edit || ToolActivity.write => Icons.edit_outlined,
  ToolActivity.commands => Icons.terminal_rounded,
  ToolActivity.webSearch => Icons.public_rounded,
  ToolActivity.webFetch => Icons.language_rounded,
  ToolActivity.subagents => Icons.hub_outlined,
  ToolActivity.plan => Icons.checklist_rounded,
  ToolActivity.questions => Icons.help_outline_rounded,
  ToolActivity.tools => Icons.auto_awesome_outlined,
};

/// Text that pulses while [active], like dsh's TextShimmer. Static when the
/// platform asks for reduced motion.
class PulseText extends StatefulWidget {
  final String text;
  final bool active;
  final TextStyle? style;
  const PulseText(this.text, {super.key, required this.active, this.style});
  @override
  State<PulseText> createState() => _PulseTextState();
}

class _PulseTextState extends State<PulseText>
    with SingleTickerProviderStateMixin {
  late final AnimationController _ctrl = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 1100),
  );

  @override
  void dispose() {
    _ctrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final animate = widget.active && !MediaQuery.disableAnimationsOf(context);
    if (animate && !_ctrl.isAnimating) _ctrl.repeat(reverse: true);
    if (!animate && _ctrl.isAnimating) _ctrl.stop();
    final text = Text(
      widget.text,
      style: widget.style,
      maxLines: 1,
      overflow: TextOverflow.ellipsis,
    );
    if (!animate) return text;
    return FadeTransition(
      opacity: Tween(begin: 0.45, end: 1.0).animate(_ctrl),
      child: text,
    );
  }
}

/// A row header shared by groups and folds: icon, title, chevron.
class _DisclosureHeader extends StatelessWidget {
  final IconData icon;
  final Color? iconColor;
  final String title;
  final bool live;
  final bool open;
  final VoidCallback onTap;
  final String semanticsLabel;
  const _DisclosureHeader({
    required this.icon,
    required this.title,
    required this.live,
    required this.open,
    required this.onTap,
    required this.semanticsLabel,
    this.iconColor,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final muted = colors.onSurfaceVariant;
    return Semantics(
      button: true,
      expanded: open,
      label: semanticsLabel,
      excludeSemantics: true,
      child: InkWell(
        borderRadius: BorderRadius.circular(8),
        onTap: onTap,
        child: ConstrainedBox(
          constraints: const BoxConstraints(minHeight: 36),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 2, vertical: 6),
            child: Row(
              children: [
                Icon(icon, size: 16, color: iconColor ?? muted),
                const SizedBox(width: 8),
                Flexible(
                  child: PulseText(
                    title,
                    active: live,
                    style: TextStyle(
                      color: muted,
                      fontSize: 13,
                      fontWeight: FontWeight.w500,
                    ),
                  ),
                ),
                const SizedBox(width: 2),
                Icon(
                  open
                      ? Icons.keyboard_arrow_up_rounded
                      : Icons.keyboard_arrow_down_rounded,
                  size: 18,
                  color: muted,
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// Consecutive tool calls as one line: "Read files and ran commands" when
/// done, the running tool's activity and detail while live.
class ToolGroupRow extends StatelessWidget {
  final ToolGroupEntry group;
  final bool open;
  final VoidCallback onToggle;
  const ToolGroupRow({
    super.key,
    required this.group,
    required this.open,
    required this.onToggle,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final running = group.live ? group.running : null;
    final ranked = rankedActivities(group.items);
    final String title;
    final ToolActivity activity;
    if (running != null) {
      activity = itemActivity(running);
      final detail = (running.payload['input_summary'] as String?)?.trim();
      title = detail == null || detail.isEmpty
          ? liveActivityLabel(activity)
          : '${liveActivityLabel(activity)} · $detail';
    } else {
      activity = ranked.firstOrNull ?? ToolActivity.tools;
      title = processTitle(ranked);
    }
    final count = group.toolCount;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _DisclosureHeader(
          icon: group.anyFailed && running == null
              ? Icons.error_outline_rounded
              : activityIcon(activity),
          iconColor: group.anyFailed && running == null ? colors.error : null,
          title: title,
          live: running != null,
          open: open,
          onTap: onToggle,
          semanticsLabel: '$title, $count tool call${count == 1 ? '' : 's'}',
        ),
        if (open)
          Container(
            margin: const EdgeInsets.only(left: 7, bottom: 4),
            padding: const EdgeInsets.only(left: 13),
            decoration: BoxDecoration(
              border: Border(left: BorderSide(color: colors.outlineVariant)),
            ),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                for (final item in group.items)
                  item.isTask
                      ? TaskStepRow(payload: item.payload)
                      : ToolStepRow(
                          key: ValueKey('step-${item.key}'),
                          payload: item.payload,
                        ),
              ],
            ),
          ),
      ],
    );
  }
}

/// One tool call inside a group; expands to its output in a terminal block.
class ToolStepRow extends StatefulWidget {
  final Map<String, dynamic> payload;
  const ToolStepRow({super.key, required this.payload});
  @override
  State<ToolStepRow> createState() => _ToolStepRowState();
}

class _ToolStepRowState extends State<ToolStepRow> {
  bool _open = false;

  String _output(Map<String, dynamic> p) {
    String encode(Object? v) =>
        v is String ? v : const JsonEncoder.withIndent('  ').convert(v);
    final preview = p['output_preview'];
    if (preview != null) return encode(preview);
    return [
      if (p['input'] != null) encode(p['input']),
      if (p['output'] != null) encode(p['output']),
      if (p['content'] != null) encode(p['content']),
    ].join('\n\n');
  }

  @override
  Widget build(BuildContext context) {
    final p = widget.payload;
    final colors = Theme.of(context).colorScheme;
    final tool = (p['tool'] ?? p['name']) as String? ?? 'Tool';
    final summary = (p['input_summary'] as String?)?.trim();
    final label = summary == null || summary.isEmpty ? tool : summary;
    final activity = toolActivity(tool);
    final running = isRunningTool(p);
    final failed = isFailedTool(p);
    final output = _output(p);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Semantics(
          button: output.isNotEmpty,
          expanded: output.isNotEmpty ? _open : null,
          label:
              '$label, ${running
                  ? 'running'
                  : failed
                  ? 'failed'
                  : 'done'}',
          excludeSemantics: true,
          child: InkWell(
            borderRadius: BorderRadius.circular(6),
            onTap: output.isEmpty ? null : () => setState(() => _open = !_open),
            child: ConstrainedBox(
              constraints: const BoxConstraints(minHeight: 32),
              child: Padding(
                padding: const EdgeInsets.symmetric(vertical: 5),
                child: Row(
                  children: [
                    Icon(
                      activityIcon(activity),
                      size: 14,
                      color: colors.onSurfaceVariant,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        label,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: TextStyle(
                          fontFamily: 'Menlo',
                          fontSize: 12,
                          color: failed ? colors.error : colors.onSurface,
                        ),
                      ),
                    ),
                    const SizedBox(width: 6),
                    if (running)
                      SizedBox.square(
                        dimension: 12,
                        child: CircularProgressIndicator(
                          strokeWidth: 1.6,
                          color: colors.primary,
                        ),
                      )
                    else if (failed)
                      Icon(Icons.close_rounded, size: 14, color: colors.error)
                    else
                      Icon(
                        Icons.check_rounded,
                        size: 14,
                        color: colors.onSurfaceVariant,
                      ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (_open && output.isNotEmpty)
          OutputBlock(
            text: output,
            command: activity == ToolActivity.commands ? summary : null,
          ),
      ],
    );
  }
}

/// Monospace output with a copy action, folded past [foldLines] lines.
class OutputBlock extends StatefulWidget {
  final String text;
  final String? command;
  static const foldLines = 24;
  const OutputBlock({super.key, required this.text, this.command});
  @override
  State<OutputBlock> createState() => _OutputBlockState();
}

class _OutputBlockState extends State<OutputBlock> {
  bool _all = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final lines = widget.text.split('\n');
    final long = lines.length > OutputBlock.foldLines;
    final shown = long && !_all
        ? lines.take(OutputBlock.foldLines).join('\n')
        : widget.text;
    final mono = TextStyle(
      fontFamily: 'Menlo',
      fontSize: 11,
      height: 1.45,
      color: colors.onSurfaceVariant,
    );
    return Container(
      width: double.infinity,
      margin: const EdgeInsets.only(bottom: 6),
      decoration: BoxDecoration(
        color: colors.surfaceContainerHighest,
        borderRadius: BorderRadius.circular(10),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              const SizedBox(width: 10),
              Expanded(
                child: Text(
                  widget.command ?? 'Output',
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: mono.copyWith(
                    color: colors.onSurface,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              IconButton(
                tooltip: 'Copy output',
                visualDensity: VisualDensity.compact,
                iconSize: 16,
                icon: const Icon(Icons.copy_rounded),
                onPressed: () =>
                    Clipboard.setData(ClipboardData(text: widget.text)),
              ),
            ],
          ),
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 0, 10, 10),
            child: SelectableText(shown, style: mono),
          ),
          if (long)
            Padding(
              padding: const EdgeInsets.only(left: 2, bottom: 4),
              child: TextButton(
                onPressed: () => setState(() => _all = !_all),
                child: Text(
                  _all ? 'Show less' : 'Show all ${lines.length} lines',
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// A task (TodoWrite) step inside a group.
class TaskStepRow extends StatelessWidget {
  final Map<String, dynamic> payload;
  const TaskStepRow({super.key, required this.payload});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final status = payload['status'] as String? ?? 'pending';
    final subject = (payload['subject'] as String?)?.trim();
    final (icon, color) = switch (status) {
      'completed' => (Icons.check_circle_outline_rounded, colors.primary),
      'in_progress' => (Icons.timelapse_rounded, colors.tertiary),
      _ => (Icons.radio_button_unchecked_rounded, colors.onSurfaceVariant),
    };
    return ConstrainedBox(
      constraints: const BoxConstraints(minHeight: 32),
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 5),
        child: Row(
          children: [
            Icon(icon, size: 14, color: color),
            const SizedBox(width: 8),
            Expanded(
              child: Text(
                subject == null || subject.isEmpty ? 'Task' : subject,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                  fontSize: 13,
                  color: colors.onSurface,
                  decoration: status == 'completed'
                      ? TextDecoration.lineThrough
                      : null,
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A finished turn's work behind "Completed in 1m 23s · 5 tool calls".
class TurnFoldRow extends StatelessWidget {
  final TurnFoldEntry fold;
  final bool open;
  final VoidCallback onToggle;
  final List<Widget> children;
  const TurnFoldRow({
    super.key,
    required this.fold,
    required this.open,
    required this.onToggle,
    required this.children,
  });

  @override
  Widget build(BuildContext context) {
    final title = turnFoldTitle(fold);
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 2),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          _DisclosureHeader(
            icon: Icons.check_circle_outline_rounded,
            title: title,
            live: false,
            open: open,
            onTap: onToggle,
            semanticsLabel: title,
          ),
          if (open) ...children,
          if (open) const Divider(height: 16),
        ],
      ),
    );
  }
}

/// "Working for 1m 23s" at the end of the running turn, ticking each second.
class RunningRow extends StatefulWidget {
  final int startTs;
  const RunningRow({super.key, required this.startTs});
  @override
  State<RunningRow> createState() => _RunningRowState();
}

class _RunningRowState extends State<RunningRow> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(
      const Duration(seconds: 1),
      (_) => mounted ? setState(() {}) : null,
    );
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final elapsed = DateTime.now().millisecondsSinceEpoch - widget.startTs;
    // Desktop clocks can be ahead of the phone; never show a negative time.
    final label = widget.startTs <= 0 || elapsed < 0
        ? 'Working'
        : 'Working for ${formatDuration(elapsed)}';
    return Semantics(
      liveRegion: false,
      label: 'Working',
      excludeSemantics: true,
      child: Padding(
        padding: const EdgeInsets.symmetric(vertical: 10),
        child: Row(
          children: [
            SizedBox.square(
              dimension: 14,
              child: CircularProgressIndicator(
                strokeWidth: 1.8,
                color: colors.primary,
              ),
            ),
            const SizedBox(width: 10),
            PulseText(
              label,
              active: true,
              style: TextStyle(
                color: colors.primary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ],
        ),
      ),
    );
  }
}
