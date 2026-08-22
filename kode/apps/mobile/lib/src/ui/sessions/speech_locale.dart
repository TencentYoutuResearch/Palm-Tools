enum SpeechInputLanguage { mandarin, english }

extension SpeechInputLanguageDetails on SpeechInputLanguage {
  String get languageCode => switch (this) {
    SpeechInputLanguage.mandarin => 'zh',
    SpeechInputLanguage.english => 'en',
  };

  String get localeLabel => switch (this) {
    SpeechInputLanguage.mandarin => '普通话',
    SpeechInputLanguage.english => 'English',
  };

  String get compactLabel => switch (this) {
    SpeechInputLanguage.mandarin => '中',
    SpeechInputLanguage.english => 'EN',
  };

  SpeechInputLanguage get next => switch (this) {
    SpeechInputLanguage.mandarin => SpeechInputLanguage.english,
    SpeechInputLanguage.english => SpeechInputLanguage.mandarin,
  };
}

/// Resolves a platform-provided speech locale for one of the two composer
/// languages. Apple commonly uses `zh-CN`, while Android commonly returns
/// `zh_CN`, so matching is performed on a normalized locale identifier.
String? resolveSpeechLocaleId(
  Iterable<String> availableLocaleIds,
  SpeechInputLanguage language,
) {
  final locales = availableLocaleIds
      .map((localeId) => (original: localeId, normalized: _normalize(localeId)))
      .toList();
  final preferences = switch (language) {
    SpeechInputLanguage.mandarin => const [
      'zh-cn',
      'zh-hans-cn',
      'cmn-hans-cn',
      'zh-hans',
      'cmn-hans',
    ],
    SpeechInputLanguage.english => const ['en-us', 'en-gb', 'en-au', 'en'],
  };

  for (final preference in preferences) {
    for (final locale in locales) {
      if (locale.normalized == preference) return locale.original;
    }
  }

  for (final locale in locales) {
    final base = locale.normalized.split('-').first;
    if (base == language.languageCode ||
        (language == SpeechInputLanguage.mandarin && base == 'cmn')) {
      return locale.original;
    }
  }
  return null;
}

String _normalize(String localeId) =>
    localeId.trim().replaceAll('_', '-').toLowerCase();
