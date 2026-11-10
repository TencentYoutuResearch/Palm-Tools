// Cross-session communication cards, mirroring dsh's presentation
// (integrations/dsh/src/agent-client.js RelayCard / MessagingTool):
//
// - An incoming session message shows "sender → current" and the actual
//   content; long messages expand in place.
// - `kode_sessions_*` tool calls show a readable title, the target and the
//   send-time delivery status, which is not task completion.
// - Raw addresses, message IDs and protocol JSON are never shown. Names are
//   resolved from this device's session list; unresolved ones read
//   "Session name unavailable".
//
// The desktop bridge supplies `relay` / `relay_tool` on semantic events; the
// original `text` / `input_summary` stay untouched for other clients.

import 'dart:convert';

import 'package:flutter/material.dart';

import '../../protocol/protocol.dart';

const unavailableSessionName = 'Session name unavailable';
const _previewChars = 180;
const _previewLines = 3;

/// Resolves a messaging address to a session title. Kode-native sessions are
/// addressed as `kode:<backend>:<uuid>`; the uuid matches this desktop's list.
String sessionNameFor(String? sessionId, List<SessionDto> sessions) {
  if (sessionId == null || sessionId.isEmpty) return unavailableSessionName;
  final parts = sessionId.split(':');
  if (parts.length >= 3 && parts.first == 'kode') {
    final backend = parts[1];
    final uuid = parts.sublist(2).join(':');
    for (final session in sessions) {
      if (session.sessionUuid != uuid) continue;
      if (session.backendKey != backend &&
          session.runtimeBackendKey != backend) {
        continue;
      }
      final title = session.title.trim();
      if (title.isNotEmpty) return title;
    }
  }
  return unavailableSessionName;
}

bool isLongRelayContent(String content) =>
    content.length > _previewChars ||
    '\n'.allMatches(content).length >= _previewLines;

/// An assistant reply that only repeats the incoming envelope adds nothing
/// beside the card (dsh hides the same exact, text-only echo).
bool isRelayEcho(String assistantText, Iterable<String> incomingTexts) {
  final text = assistantText.trim();
  for (final raw in incomingTexts) {
    final envelope = raw.trim();
    if (envelope.isEmpty) continue;
    if (text == envelope) return true;
    if (text.endsWith(envelope)) {
      final label = text.substring(0, text.length - envelope.length);
      if (RegExp(r'^[^\r\n:]{1,80}: ?$').hasMatch(label)) return true;
    }
  }
  return false;
}

const _toolTitles = {
  'list': 'Find sessions',
  'create': 'Create collaborator session',
  'send': 'Send session message',
  'read': 'Read session messages',
  'wait': 'Wait for session reply',
};

const _deliveryLabels = {
  'queued': 'queued',
  'received': 'reached the target node',
  'delivering': 'delivering',
  'accepted': 'handed to the target session',
  'uncertain': 'outcome pending confirmation',
  'rejected': 'rejected',
  'expired': 'expired',
};

String sessionToolTitle(Map<String, dynamic> relay) {
  final op = relay['op'] as String? ?? '';
  if (op == 'send' && relay['in_reply_to'] != null) return 'Reply to session';
  return _toolTitles[op] ?? 'Session communication';
}

/// Status line for a session tool, read from the result JSON when present.
String sessionToolStatus(Map<String, dynamic> payload) {
  final status = payload['status'] as String? ?? 'running';
  if (status == 'error') return 'Call failed';
  if (status == 'running' || status == 'pending' || status == 'in_progress') {
    return 'In progress';
  }
  final result = _resultJson(payload);
  final message = result?['message'];
  if (message is Map && message['status'] is String) {
    final value = message['status'] as String;
    return 'At send: ${_deliveryLabels[value] ?? value}';
  }
  if (result?['timed_out'] == true) return 'No new messages yet';
  return 'Returned';
}

Map<String, dynamic>? _resultJson(Map<String, dynamic> payload) {
  for (final key in ['output_preview', 'output']) {
    final raw = payload[key];
    if (raw is Map<String, dynamic>) return raw;
    if (raw is! String || raw.isEmpty) continue;
    try {
      final value = jsonDecode(raw);
      if (value is Map<String, dynamic>) return value;
    } catch (_) {
      // Truncated or plain-text output carries no structured status.
    }
  }
  return null;
}

class RelayMessageCard extends StatelessWidget {
  final Map<String, dynamic> relay;
  final String currentTitle;
  final List<SessionDto> sessions;
  final int? timestamp;

  const RelayMessageCard({
    super.key,
    required this.relay,
    required this.currentTitle,
    required this.sessions,
    this.timestamp,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final sender = sessionNameFor(relay['from_session'] as String?, sessions);
    final content = relay['content'] as String? ?? '';
    final time = timestamp == null || timestamp! <= 0
        ? null
        : MaterialLocalizations.of(context).formatTimeOfDay(
            TimeOfDay.fromDateTime(
              DateTime.fromMillisecondsSinceEpoch(timestamp!),
            ),
            alwaysUse24HourFormat: MediaQuery.alwaysUse24HourFormatOf(context),
          );
    return _CardFrame(
      children: [
        _Heading(
          from: sender,
          to: '${currentTitle.isEmpty ? unavailableSessionName : currentTitle} (current)',
          trailing: time,
        ),
        const SizedBox(height: 4),
        Text(
          relay['reply_to'] != null
              ? 'Replied to this conversation'
              : 'Sent a message',
          style: TextStyle(fontSize: 12, color: colors.onSurfaceVariant),
        ),
        const SizedBox(height: 6),
        _ExpandableContent(content: content),
      ],
    );
  }
}

class SessionToolCard extends StatefulWidget {
  final Map<String, dynamic> payload;
  final String currentTitle;
  final List<SessionDto> sessions;

  const SessionToolCard({
    super.key,
    required this.payload,
    required this.currentTitle,
    required this.sessions,
  });

  @override
  State<SessionToolCard> createState() => _SessionToolCardState();
}

class _SessionToolCardState extends State<SessionToolCard> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final relay = Map<String, dynamic>.from(
      widget.payload['relay_tool'] as Map,
    );
    final status = sessionToolStatus(widget.payload);
    final failed = widget.payload['status'] == 'error';
    final content = relay['content'] as String? ?? '';
    final target = relay['session_id'] as String?;
    final current = widget.currentTitle.isEmpty
        ? unavailableSessionName
        : widget.currentTitle;
    final result = _resultJson(widget.payload);
    final created = relay['op'] == 'create'
        ? (result?['title'] as String? ??
              relay['title'] as String? ??
              'Collaborator')
        : null;
    final found = result?['sessions'];
    return _CardFrame(
      children: [
        InkWell(
          onTap: () => setState(() => _open = !_open),
          child: Row(
            children: [
              Icon(Icons.send_rounded, size: 15, color: colors.primary),
              const SizedBox(width: 6),
              Expanded(
                child: Text(
                  sessionToolTitle(relay),
                  style: const TextStyle(
                    fontSize: 13,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ),
              Text(
                status,
                style: TextStyle(
                  fontSize: 12,
                  color: failed ? colors.error : colors.onSurfaceVariant,
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
        if (target != null) ...[
          const SizedBox(height: 6),
          _Heading(
            from: '$current (current)',
            to: sessionNameFor(target, widget.sessions),
          ),
        ],
        if (created != null) ...[
          const SizedBox(height: 6),
          Text(
            'New session: $created${relay['host'] != null ? ' · ${relay['host']}' : ''}',
            style: TextStyle(fontSize: 12, color: colors.onSurfaceVariant),
          ),
        ],
        if (content.isNotEmpty) ...[
          const SizedBox(height: 6),
          _open
              ? SelectableText(content, style: const TextStyle(fontSize: 14))
              : Text(
                  content,
                  maxLines: _previewLines,
                  overflow: TextOverflow.ellipsis,
                  style: const TextStyle(fontSize: 14),
                ),
        ],
        if (_open) ...[
          if (relay['op'] == 'send') ...[
            const SizedBox(height: 6),
            Text(
              'Delivery status does not mean the target task is complete.',
              style: TextStyle(fontSize: 12, color: colors.onSurfaceVariant),
            ),
          ],
          if (failed) ...[
            const SizedBox(height: 6),
            Text(
              'Communication failed; see the desktop session for details.',
              style: TextStyle(fontSize: 12, color: colors.error),
            ),
          ],
          if (found is List && found.isNotEmpty) ...[
            const SizedBox(height: 6),
            for (final row in found.whereType<Map>())
              Text(
                '• ${(row['title'] as String?)?.trim().isNotEmpty == true ? row['title'] : unavailableSessionName}',
                style: const TextStyle(fontSize: 13),
              ),
          ],
        ],
      ],
    );
  }
}

class _CardFrame extends StatelessWidget {
  final List<Widget> children;
  const _CardFrame({required this.children});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 6),
      padding: const EdgeInsets.fromLTRB(12, 10, 12, 10),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(12),
        border: Border.all(color: colors.primary.withValues(alpha: 0.35)),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: children,
      ),
    );
  }
}

class _Heading extends StatelessWidget {
  final String from;
  final String to;
  final String? trailing;
  const _Heading({required this.from, required this.to, this.trailing});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    const strong = TextStyle(fontSize: 13, fontWeight: FontWeight.w600);
    return Row(
      children: [
        Icon(Icons.forum_outlined, size: 15, color: colors.primary),
        const SizedBox(width: 6),
        Flexible(
          child: Text(from, style: strong, overflow: TextOverflow.ellipsis),
        ),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 6),
          child: Text('→', style: TextStyle(color: colors.onSurfaceVariant)),
        ),
        Flexible(
          child: Text(to, style: strong, overflow: TextOverflow.ellipsis),
        ),
        if (trailing != null) ...[
          const SizedBox(width: 8),
          Text(
            trailing!,
            style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
          ),
        ],
      ],
    );
  }
}

class _ExpandableContent extends StatefulWidget {
  final String content;
  const _ExpandableContent({required this.content});

  @override
  State<_ExpandableContent> createState() => _ExpandableContentState();
}

class _ExpandableContentState extends State<_ExpandableContent> {
  bool _open = false;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final long = isLongRelayContent(widget.content);
    return Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        _open || !long
            ? SelectableText(
                widget.content,
                style: const TextStyle(fontSize: 14, height: 1.4),
              )
            : Text(
                widget.content,
                maxLines: _previewLines,
                overflow: TextOverflow.ellipsis,
                style: const TextStyle(fontSize: 14, height: 1.4),
              ),
        if (long)
          TextButton(
            style: TextButton.styleFrom(
              padding: EdgeInsets.zero,
              minimumSize: const Size(0, 32),
              foregroundColor: colors.primary,
            ),
            onPressed: () => setState(() => _open = !_open),
            child: Text(_open ? 'Show less' : 'Show full message'),
          ),
      ],
    );
  }
}
