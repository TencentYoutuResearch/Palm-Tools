import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/ui/sessions/transcript_turns.dart';

TurnInput user(String k, int ts) => TurnInput(
  key: k,
  type: 'message',
  ts: ts,
  payload: {'role': 'user', 'text': k},
);
TurnInput reply(String k, int ts, {bool hidden = false}) => TurnInput(
  key: k,
  type: 'message',
  ts: ts,
  payload: {'role': 'assistant', 'text': k},
  hidden: hidden,
);
TurnInput tool(String k, int ts, String name, {String status = 'ok'}) =>
    TurnInput(
      key: k,
      type: 'tool_use',
      ts: ts,
      payload: {'tool': name, 'status': status},
    );

List<String> keys(List<TranscriptEntry> entries) => [
  for (final e in entries) e.key,
];

void main() {
  test('a finished turn folds tools and interim replies behind one row', () {
    final entries = buildTranscript([
      user('u1', 1000),
      reply('r1', 2000),
      tool('t1', 3000, 'Read'),
      tool('t2', 4000, 'Bash'),
      reply('r2', 5000),
      tool('t3', 6000, 'Bash'),
      reply('final', 84000),
    ], running: false);
    expect(keys(entries), ['u1', 'fold-r1', 'final']);
    final fold = entries[1] as TurnFoldEntry;
    expect(fold.durationMs, 83000);
    expect(fold.toolCount, 3);
    expect(fold.messageCount, 2);
    expect(
      turnFoldTitle(fold),
      'Completed in 1m 23s · 3 tool calls · 2 messages',
    );
    expect(keys(fold.children), ['r1', 'group-t1', 'r2', 'group-t3']);
    expect((entries[2] as ItemEntry).turnDurationMs, isNull);
  });

  test('a turn with only a reply shows its duration on the reply', () {
    final entries = buildTranscript([
      user('u1', 1000),
      reply('r1', 13000),
    ], running: false);
    expect(keys(entries), ['u1', 'r1']);
    expect((entries[1] as ItemEntry).turnDurationMs, 12000);
  });

  test('the running turn keeps steps visible and groups consecutive tools', () {
    final entries = buildTranscript([
      user('u1', 1),
      reply('done', 2),
      user('u2', 10),
      tool('t1', 11, 'Grep'),
      tool('t2', 12, 'Read'),
      reply('r', 13),
      tool('t3', 14, 'Bash', status: 'running'),
    ], running: true);
    expect(keys(entries), [
      'u1',
      'done',
      'u2',
      'group-t1',
      'r',
      'group-t3',
      'running',
    ]);
    final live = entries[5] as ToolGroupEntry;
    expect(live.live, isTrue);
    expect(live.running?.key, 't3');
    expect((entries[3] as ToolGroupEntry).live, isFalse);
    expect((entries.last as RunningEntry).startTs, 10);
  });

  test('questions, plans and session tools are never folded', () {
    final entries = buildTranscript([
      user('u1', 1),
      tool('t1', 2, 'Read'),
      const TurnInput(
        key: 'ask',
        type: 'ask_user_question',
        ts: 3,
        payload: {},
      ),
      const TurnInput(
        key: 'relay',
        type: 'tool_use',
        ts: 4,
        payload: {
          'relay_tool': {'op': 'send'},
        },
      ),
      reply('echo', 5, hidden: true),
      reply('final', 6),
    ], running: false);
    expect(keys(entries), ['u1', 'fold-t1', 'ask', 'relay', 'final']);
  });

  test('history before the first user message forms its own turn', () {
    final entries = buildTranscript([
      tool('t1', 1, 'Read'),
      reply('r', 2),
      user('u', 3),
    ], running: false);
    expect(keys(entries), ['fold-t1', 'r', 'u']);
  });

  test('tool names map to dsh activities and titles', () {
    expect(toolActivity('Bash'), ToolActivity.commands);
    expect(toolActivity('shell'), ToolActivity.commands);
    expect(toolActivity('apply_patch'), ToolActivity.edit);
    expect(toolActivity('mcp__memory__memory_search'), ToolActivity.tools);
    expect(toolActivity('Grep'), ToolActivity.search);
    expect(toolActivity('Task'), ToolActivity.subagents);
    final ranked = rankedActivities([
      tool('a', 1, 'Read'),
      tool('b', 2, 'Bash'),
      tool('c', 3, 'Bash'),
      tool('d', 4, 'Grep'),
      tool('e', 5, 'WebFetch'),
    ]);
    expect(
      processTitle(ranked),
      'Ran commands, read files, searched code, etc.',
    );
    expect(
      processTitle(ranked.take(2).toList()),
      'Ran commands and read files',
    );
    expect(formatDuration(400), '<1s');
    expect(formatDuration(3_725_000), '1h 2m');
  });
}
