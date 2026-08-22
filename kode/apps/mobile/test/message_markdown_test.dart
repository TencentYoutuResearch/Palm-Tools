import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/ui/sessions/message_markdown.dart';

void main() {
  group('normalizeMessageMarkdown', () {
    test('flattens Codex protocol markers without changing their meaning', () {
      const input = '''>>>> TRANSCRIPT DELTA END

Reviewed session.

> > > > APPROVAL REQUEST START
body
>>>> approval request end''';

      final output = normalizeMessageMarkdown(input);

      expect(output, contains('**TRANSCRIPT DELTA END**'));
      expect(output, contains('**APPROVAL REQUEST START**'));
      expect(output, contains('**APPROVAL REQUEST END**'));
      expect(output, isNot(contains('>>>>')));
      expect(output, contains('Reviewed session.'));
    });

    test('preserves ordinary and authored nested blockquotes', () {
      const input = '> ordinary quote\n>> intentionally nested quote';

      expect(normalizeMessageMarkdown(input), input);
    });

    test('does not rewrite examples inside fenced code', () {
      const input = '''```text
>>>> APPROVAL REQUEST START
```
>>>> APPROVAL REQUEST END''';

      expect(normalizeMessageMarkdown(input), '''```text
>>>> APPROVAL REQUEST START
```
**APPROVAL REQUEST END**''');
    });

    test('normalizes CRLF for stable Markdown rendering', () {
      expect(
        normalizeMessageMarkdown('one\r\n>>>> TRANSCRIPT DELTA END\r\n'),
        'one\n**TRANSCRIPT DELTA END**\n',
      );
    });
  });
}
