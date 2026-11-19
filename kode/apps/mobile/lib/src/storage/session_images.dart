// Phone copies of transcript images the desktop cached for this session.
//
// Events name an image by content id; the bytes are read from the desktop on
// first view and kept in the app cache directory for [retention] after the
// last view, so scrolling back or reopening a session does not download them
// again. The OS may purge the cache early; a missing copy is fetched again.
import 'dart:io';

import 'package:path_provider/path_provider.dart';

import '../api/api_client.dart';

/// `{ id, mime, size }` as carried in a `message` or `tool_use` payload.
class SessionImageRef {
  final String id;
  final String mime;
  final int size;

  const SessionImageRef({
    required this.id,
    required this.mime,
    required this.size,
  });

  static final _id = RegExp(r'^[0-9a-f]{32}$');

  String get extension => switch (mime) {
    'image/jpeg' => 'jpg',
    'image/gif' => 'gif',
    'image/webp' => 'webp',
    _ => 'png',
  };

  String get name => 'kode-$id.$extension';

  /// Valid refs in [raw]; anything else in the list is skipped, so a
  /// malformed id can never name a path outside the cache.
  static List<SessionImageRef> listFrom(Object? raw) {
    if (raw is! List) return const [];
    return [
      for (final item in raw)
        if (item is Map &&
            item['id'] is String &&
            _id.hasMatch(item['id'] as String))
          SessionImageRef(
            id: item['id'] as String,
            mime: item['mime'] as String? ?? 'image/png',
            size: (item['size'] as num?)?.toInt() ?? 0,
          ),
    ];
  }
}

class SessionImageStore {
  SessionImageStore._();

  static final instance = SessionImageStore._();

  static const retention = Duration(days: 7);

  final Map<String, Future<File>> _inflight = {};
  Future<Directory>? _dir;

  Future<Directory> _directory() => _dir ??= () async {
    final base = await getApplicationCacheDirectory();
    final dir = Directory('${base.path}/kode-session-images');
    await dir.create(recursive: true);
    // Before any download starts, so a fresh `.part` is never swept.
    await _sweep(dir);
    return dir;
  }();

  /// The local copy of [ref], downloading it through [api] on first use.
  Future<File> fetch(SessionImageRef ref, ApiClient api) {
    return _inflight[ref.id] ??= _fetch(
      ref,
      api,
    ).whenComplete(() => _inflight.remove(ref.id));
  }

  Future<File> _fetch(SessionImageRef ref, ApiClient api) async {
    final dir = await _directory();
    final file = File('${dir.path}/${ref.name}');
    if (await file.exists()) {
      // Viewing an image keeps it for another full retention period.
      try {
        await file.setLastModified(DateTime.now());
      } catch (_) {}
      return file;
    }
    final part = File('${file.path}.part');
    final sink = part.openWrite();
    try {
      await api.downloadImage(ref.id, sink);
      await sink.close();
      return await part.rename(file.path);
    } catch (_) {
      await sink.close().catchError((_) {});
      try {
        await part.delete();
      } catch (_) {}
      rethrow;
    }
  }

  Future<void> _sweep(Directory dir) async {
    final cutoff = DateTime.now().subtract(retention);
    try {
      await for (final entry in dir.list()) {
        if (entry is! File) continue;
        final stale =
            entry.path.endsWith('.part') ||
            (await entry.lastModified()).isBefore(cutoff);
        if (stale) {
          try {
            await entry.delete();
          } catch (_) {}
        }
      }
    } catch (_) {}
  }
}
