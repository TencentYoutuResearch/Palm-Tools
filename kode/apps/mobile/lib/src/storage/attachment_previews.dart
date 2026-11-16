// Short-lived local copies of files this phone attached to a session.
//
// The desktop keeps the uploaded file; the phone keeps its own copy for
// [retention] so the transcript can show thumbnails and open the file without
// downloading it back. Entries are keyed by the desktop path the message
// references and live in the app's temp directory, so the OS may also purge
// them early; a missing copy just falls back to a name-only chip.
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:path_provider/path_provider.dart';

import '../protocol/attachments.dart';

class AttachmentPreview {
  final String remotePath;
  final String localPath;
  final String name;
  final int size;
  final int sessionId;
  final int savedAtMs;

  const AttachmentPreview({
    required this.remotePath,
    required this.localPath,
    required this.name,
    required this.size,
    required this.sessionId,
    required this.savedAtMs,
  });

  AttachmentKind get kind => attachmentKindOf(name);

  Map<String, dynamic> toJson() => {
    'remote_path': remotePath,
    'local_path': localPath,
    'name': name,
    'size': size,
    'session_id': sessionId,
    'saved_at_ms': savedAtMs,
  };

  static AttachmentPreview? fromJson(Object? raw) {
    if (raw is! Map) return null;
    final remote = raw['remote_path'];
    final local = raw['local_path'];
    if (remote is! String || local is! String) return null;
    return AttachmentPreview(
      remotePath: remote,
      localPath: local,
      name: raw['name'] as String? ?? remote.split('/').last,
      size: (raw['size'] as num?)?.toInt() ?? 0,
      sessionId: (raw['session_id'] as num?)?.toInt() ?? 0,
      savedAtMs: (raw['saved_at_ms'] as num?)?.toInt() ?? 0,
    );
  }
}

class AttachmentPreviewStore extends ChangeNotifier {
  AttachmentPreviewStore._();

  static final instance = AttachmentPreviewStore._();

  static const retention = Duration(hours: 24);

  final Map<String, AttachmentPreview> _entries = {};
  Future<void>? _loading;
  Directory? _dir;

  AttachmentPreview? lookup(String remotePath) {
    final entry = _entries[remotePath];
    if (entry == null || !File(entry.localPath).existsSync()) return null;
    return entry;
  }

  Future<void> ensureLoaded() => _loading ??= _load();

  /// A path for a copy this store will own; the caller writes the file.
  Future<File> reserve(String name) async {
    await ensureLoaded();
    final dir = Directory(
      '${_dir!.path}/${DateTime.now().microsecondsSinceEpoch}',
    );
    await dir.create(recursive: true);
    return File('${dir.path}/$name');
  }

  Future<void> remember({
    required String remotePath,
    required File copy,
    required String name,
    required int size,
    required int sessionId,
  }) async {
    await ensureLoaded();
    _entries[remotePath] = AttachmentPreview(
      remotePath: remotePath,
      localPath: copy.path,
      name: name,
      size: size,
      sessionId: sessionId,
      savedAtMs: DateTime.now().millisecondsSinceEpoch,
    );
    notifyListeners();
    await _save();
  }

  /// Drops a reserved copy that never made it into a message.
  Future<void> discard(File copy) async {
    try {
      await copy.parent.delete(recursive: true);
    } catch (_) {}
  }

  Future<void> _load() async {
    final temp = await getTemporaryDirectory();
    final dir = Directory('${temp.path}/kode-attachment-previews');
    await dir.create(recursive: true);
    _dir = dir;
    final cutoff = DateTime.now().subtract(retention).millisecondsSinceEpoch;
    try {
      final raw = jsonDecode(await _index.readAsString());
      for (final item in raw is List ? raw : const []) {
        final entry = AttachmentPreview.fromJson(item);
        if (entry != null && entry.savedAtMs >= cutoff) {
          _entries[entry.remotePath] = entry;
        }
      }
    } catch (_) {}
    // Remove folders no live entry points at, including expired ones and
    // copies reserved for messages that were never sent.
    final live = _entries.values.map((e) => File(e.localPath).parent.path);
    final keep = live.toSet();
    await for (final child in dir.list()) {
      if (child is Directory && !keep.contains(child.path)) {
        final age = DateTime.now().difference((await child.stat()).modified);
        if (age > const Duration(hours: 1)) {
          try {
            await child.delete(recursive: true);
          } catch (_) {}
        }
      }
    }
    notifyListeners();
    await _save();
  }

  File get _index => File('${_dir!.path}/index.json');

  Future<void> _save() async {
    final data = jsonEncode(_entries.values.map((e) => e.toJson()).toList());
    try {
      await _index.writeAsString(data, flush: true);
    } catch (_) {}
  }
}
