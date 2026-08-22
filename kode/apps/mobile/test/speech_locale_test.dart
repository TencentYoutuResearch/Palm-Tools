import 'package:flutter_test/flutter_test.dart';
import 'package:kode_mobile/src/ui/sessions/speech_locale.dart';

void main() {
  group('resolveSpeechLocaleId', () {
    test('prefers mainland Mandarin across platform locale formats', () {
      expect(
        resolveSpeechLocaleId([
          'zh_TW',
          'en_US',
          'zh_CN',
        ], SpeechInputLanguage.mandarin),
        'zh_CN',
      );
      expect(
        resolveSpeechLocaleId([
          'en-US',
          'zh-Hans-CN',
        ], SpeechInputLanguage.mandarin),
        'zh-Hans-CN',
      );
    });

    test('prefers US English and falls back to another English locale', () {
      expect(
        resolveSpeechLocaleId(['en_GB', 'en_US'], SpeechInputLanguage.english),
        'en_US',
      );
      expect(
        resolveSpeechLocaleId(['fr-FR', 'en-IN'], SpeechInputLanguage.english),
        'en-IN',
      );
    });

    test('returns null when the requested language is unavailable', () {
      expect(
        resolveSpeechLocaleId(['ja-JP', 'fr-FR'], SpeechInputLanguage.mandarin),
        isNull,
      );
    });
  });
}
