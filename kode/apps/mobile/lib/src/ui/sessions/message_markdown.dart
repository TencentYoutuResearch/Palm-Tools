final _protocolMarker = RegExp(
  r'^[ \t]*(?:>[ \t]*){2,}(TRANSCRIPT[ \t]+DELTA|APPROVAL[ \t]+REQUEST)[ \t]+(START|END)[ \t]*$',
  caseSensitive: false,
);

final _fenceMarker = RegExp(r'^[ \t]{0,3}(`{3,}|~{3,})');

/// Prevents Codex transport sentinels such as `>>>> APPROVAL REQUEST START`
/// from being interpreted as four nested Markdown blockquotes.
///
/// The source event is intentionally left untouched; this is a display-only
/// normalization. Ordinary authored blockquotes and fenced code are preserved.
String normalizeMessageMarkdown(String source) {
  final normalized = source.replaceAll('\r\n', '\n').replaceAll('\r', '\n');
  final lines = normalized.split('\n');
  String? fenceCharacter;
  var fenceLength = 0;

  for (var index = 0; index < lines.length; index++) {
    final line = lines[index];
    final fence = _fenceMarker.firstMatch(line)?.group(1);
    if (fence != null) {
      final character = fence[0];
      if (fenceCharacter == null) {
        fenceCharacter = character;
        fenceLength = fence.length;
      } else if (character == fenceCharacter && fence.length >= fenceLength) {
        fenceCharacter = null;
        fenceLength = 0;
      }
      continue;
    }
    if (fenceCharacter != null) continue;

    final match = _protocolMarker.firstMatch(line);
    if (match == null) continue;
    final family = match.group(1)!.replaceAll(RegExp(r'[ \t]+'), ' ');
    final edge = match.group(2)!;
    lines[index] = '**${family.toUpperCase()} ${edge.toUpperCase()}**';
  }

  return lines.join('\n');
}
