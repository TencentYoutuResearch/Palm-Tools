// Phone copies of transcript images the desktop cached for this session.
//
// Events name an image by content id; the bytes are read from the desktop on
// first view and kept in the app cache directory for [retention] after the
// last view, so scrolling back or reopening a session does not download them
// again. The OS may purge the cache early; a missing copy is fetched again.
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../api/api_client.dart';
import '../protocol/protocol.dart';

export '../protocol/protocol.dart' show SessionImageRef;

class SessionImageStore {
  SessionImageStore._([Future<Directory> Function()? baseDir])
    : _baseDir = baseDir ?? getApplicationCacheDirectory;

  static final instance = SessionImageStore._();

  @visibleForTesting
  SessionImageStore.withCacheDirectory(Directory dir)
    : _baseDir = (() async => dir);

  static const retention = Duration(days: 7);

  final Future<Directory> Function() _baseDir;
  final Map<String, Future<File>> _inflight = {};
  Future<Directory>? _dir;

  Future<Directory> _directory() => _dir ??= () async {
    final base = await _baseDir();
    final dir = Directory('${base.path}/kode-session-images');
    await dir.create(recursive: true);
    // Before any download starts, so a fresh `.part` is never swept.
    await _sweep(dir);
    return dir;
  }();

  /// The local copy of [ref], downloading it through [api] on first use.
  Future<File> fetch(SessionImageRef ref, ApiClient api) {
    return _inflight[ref.id] ??= _fetch(ref, api).whenComplete(() {
      // Block body is mandatory: `Map.remove` returns the `Future<File>` value
      // itself, which would make `whenComplete` await itself forever.
      _inflight.remove(ref.id);
    });
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
