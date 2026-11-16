import 'dart:async';
import 'dart:io';

import 'package:dio/dio.dart';
import 'package:file_picker/file_picker.dart';
import 'package:flutter/material.dart';
import 'package:image_picker/image_picker.dart';

import '../../api/api_client.dart';
import '../../protocol/attachments.dart';
import '../../storage/attachment_previews.dart';
import 'attachment_views.dart';

enum ComposerAttachmentStatus { uploading, ready, failed }

/// A file picked into the composer. [copy] is the phone's own preview copy,
/// which also serves as the upload source because picker files may vanish.
class ComposerAttachment {
  final String id;
  final String name;
  final int size;
  final File copy;
  ComposerAttachmentStatus status = ComposerAttachmentStatus.uploading;
  double progress = 0;
  String? remotePath;
  String? error;
  CancelToken? cancel;

  ComposerAttachment({
    required this.id,
    required this.name,
    required this.size,
    required this.copy,
  });

  AttachmentKind get kind => attachmentKindOf(name);
}

/// Uploads picked files as soon as they are added so Send only has to name
/// the desktop paths.
class ComposerAttachments extends ChangeNotifier {
  final ApiClient? Function() api;
  final List<ComposerAttachment> _items = [];
  var _sequence = 0;

  ComposerAttachments(this.api);

  List<ComposerAttachment> get items => List.unmodifiable(_items);
  bool get isEmpty => _items.isEmpty;
  bool get uploading =>
      _items.any((item) => item.status == ComposerAttachmentStatus.uploading);
  bool get failed =>
      _items.any((item) => item.status == ComposerAttachmentStatus.failed);
  int get remaining => maxAttachmentsPerMessage - _items.length;

  /// Adds picked files; returns a message for anything that was skipped.
  Future<String?> addAll(List<({String path, String name})> picked) async {
    final skipped = <String>[];
    for (final file in picked) {
      if (remaining <= 0) {
        skipped.add('Up to $maxAttachmentsPerMessage files per message.');
        break;
      }
      final source = File(file.path);
      final size = await source.length();
      if (size <= 0) {
        skipped.add('${file.name} is empty.');
        continue;
      }
      if (size > maxAttachmentBytes) {
        skipped.add(
          '${file.name} is larger than ${formatAttachmentSize(maxAttachmentBytes)}.',
        );
        continue;
      }
      final copy = await AttachmentPreviewStore.instance.reserve(
        _safeName(file.name),
      );
      await source.copy(copy.path);
      final item = ComposerAttachment(
        id: '${DateTime.now().microsecondsSinceEpoch}-${_sequence++}',
        name: file.name,
        size: size,
        copy: copy,
      );
      _items.add(item);
      notifyListeners();
      unawaited(_upload(item));
    }
    return skipped.isEmpty ? null : skipped.join('\n');
  }

  void retry(String id) {
    final item = _items.where((item) => item.id == id).firstOrNull;
    if (item == null || item.status != ComposerAttachmentStatus.failed) return;
    item
      ..status = ComposerAttachmentStatus.uploading
      ..progress = 0
      ..error = null;
    notifyListeners();
    unawaited(_upload(item));
  }

  void remove(String id) {
    final item = _items.where((item) => item.id == id).firstOrNull;
    if (item == null) return;
    item.cancel?.cancel();
    _items.remove(item);
    unawaited(AttachmentPreviewStore.instance.discard(item.copy));
    notifyListeners();
  }

  /// Hands the uploaded files to a message: their previews are kept for the
  /// transcript and the composer is cleared.
  List<String> commit(int sessionId) {
    final ready = _items
        .where((item) => item.status == ComposerAttachmentStatus.ready)
        .toList();
    _items.clear();
    notifyListeners();
    for (final item in ready) {
      unawaited(
        AttachmentPreviewStore.instance.remember(
          remotePath: item.remotePath!,
          copy: item.copy,
          name: item.name,
          size: item.size,
          sessionId: sessionId,
        ),
      );
    }
    return [for (final item in ready) item.remotePath!];
  }

  Future<void> _upload(ComposerAttachment item) async {
    final client = api();
    if (client == null) {
      _fail(item, 'Desktop connection unavailable.');
      return;
    }
    final cancel = item.cancel = CancelToken();
    try {
      final path = await client.uploadAttachment(
        item.copy,
        name: item.name,
        cancelToken: cancel,
        onProgress: (progress) {
          item.progress = progress;
          notifyListeners();
        },
      );
      if (cancel.isCancelled) return;
      item
        ..remotePath = path
        ..status = ComposerAttachmentStatus.ready;
      notifyListeners();
    } on ApiException catch (error) {
      _fail(item, error.detail.isEmpty ? error.error : error.detail);
    } on DioException catch (error) {
      if (CancelToken.isCancel(error)) return;
      _fail(item, 'Upload failed. Check the connection and retry.');
    } catch (error) {
      _fail(item, '$error');
    }
  }

  void _fail(ComposerAttachment item, String error) {
    if (!_items.contains(item)) return;
    item
      ..status = ComposerAttachmentStatus.failed
      ..error = error;
    notifyListeners();
  }

  @override
  void dispose() {
    for (final item in _items) {
      item.cancel?.cancel();
      unawaited(AttachmentPreviewStore.instance.discard(item.copy));
    }
    _items.clear();
    super.dispose();
  }
}

String _safeName(String name) {
  final base = name.split(RegExp(r'[\\/]')).last;
  return base.isEmpty ? 'attachment' : base;
}

enum _AttachmentSource { library, camera, files }

/// Codex-style "+" menu: photo library, camera, or any file.
Future<List<({String path, String name})>> pickComposerAttachments(
  BuildContext context, {
  required int limit,
}) async {
  final source = await showModalBottomSheet<_AttachmentSource>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          ListTile(
            key: const ValueKey('attach-library'),
            leading: const Icon(Icons.photo_library_outlined),
            title: const Text('Photos & videos'),
            onTap: () => Navigator.pop(context, _AttachmentSource.library),
          ),
          ListTile(
            key: const ValueKey('attach-camera'),
            leading: const Icon(Icons.photo_camera_outlined),
            title: const Text('Take photo'),
            onTap: () => Navigator.pop(context, _AttachmentSource.camera),
          ),
          ListTile(
            key: const ValueKey('attach-files'),
            leading: const Icon(Icons.attach_file_rounded),
            title: const Text('Files'),
            subtitle: Text(
              'Up to ${formatAttachmentSize(maxAttachmentBytes)} each',
            ),
            onTap: () => Navigator.pop(context, _AttachmentSource.files),
          ),
        ],
      ),
    ),
  );
  if (source == null) return const [];
  // Large photos are downscaled to JPEG: agents read JPEG, not HEIC, and
  // downsample big images anyway.
  final picker = ImagePicker();
  switch (source) {
    case _AttachmentSource.library:
      final media = await picker.pickMultipleMedia(
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
        limit: limit > 1 ? limit : null,
      );
      return [for (final file in media) (path: file.path, name: file.name)];
    case _AttachmentSource.camera:
      final photo = await picker.pickImage(
        source: ImageSource.camera,
        maxWidth: 2048,
        maxHeight: 2048,
        imageQuality: 85,
      );
      return photo == null ? const [] : [(path: photo.path, name: photo.name)];
    case _AttachmentSource.files:
      final result = await FilePicker.pickFiles(allowMultiple: limit > 1);
      return [
        for (final file in result?.files ?? const <PlatformFile>[])
          if (file.path != null) (path: file.path!, name: file.name),
      ];
  }
}

/// Pending files above the composer input, with upload state.
class ComposerAttachmentStrip extends StatelessWidget {
  final ComposerAttachments attachments;

  const ComposerAttachmentStrip({super.key, required this.attachments});

  @override
  Widget build(BuildContext context) {
    final items = attachments.items;
    if (items.isEmpty) return const SizedBox.shrink();
    return SizedBox(
      key: const ValueKey('composer-attachments'),
      height: 72,
      child: ListView.separated(
        scrollDirection: Axis.horizontal,
        padding: const EdgeInsets.fromLTRB(4, 6, 4, 4),
        itemCount: items.length,
        separatorBuilder: (_, _) => const SizedBox(width: 8),
        itemBuilder: (context, index) =>
            _PendingTile(item: items[index], attachments: attachments),
      ),
    );
  }
}

class _PendingTile extends StatelessWidget {
  final ComposerAttachment item;
  final ComposerAttachments attachments;

  const _PendingTile({required this.item, required this.attachments});

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final failed = item.status == ComposerAttachmentStatus.failed;
    final uploading = item.status == ComposerAttachmentStatus.uploading;
    return Semantics(
      label: failed
          ? '${item.name}, upload failed. Tap to retry.'
          : uploading
          ? '${item.name}, uploading ${(item.progress * 100).round()}%'
          : '${item.name}, ready',
      child: SizedBox(
        width: 62,
        height: 62,
        child: Stack(
          clipBehavior: Clip.none,
          children: [
            Positioned.fill(
              child: GestureDetector(
                onTap: failed
                    ? () {
                        ScaffoldMessenger.of(context).showSnackBar(
                          SnackBar(
                            content: Text(item.error ?? 'Upload failed'),
                          ),
                        );
                        attachments.retry(item.id);
                      }
                    : () => openLocalAttachment(
                        context,
                        path: item.copy.path,
                        name: item.name,
                        size: item.size,
                      ),
                child: AttachmentThumb(
                  name: item.name,
                  localPath: item.copy.path,
                  size: 62,
                ),
              ),
            ),
            if (uploading || failed)
              Positioned.fill(
                child: IgnorePointer(
                  child: DecoratedBox(
                    decoration: BoxDecoration(
                      color: Colors.black.withValues(alpha: 0.38),
                      borderRadius: BorderRadius.circular(12),
                    ),
                    child: Center(
                      child: failed
                          ? const Icon(
                              Icons.refresh_rounded,
                              color: Colors.white,
                            )
                          : SizedBox(
                              width: 24,
                              height: 24,
                              child: CircularProgressIndicator(
                                strokeWidth: 2.5,
                                color: Colors.white,
                                value: item.progress > 0 ? item.progress : null,
                              ),
                            ),
                    ),
                  ),
                ),
              ),
            Positioned(
              top: -6,
              right: -6,
              child: Material(
                color: colors.inverseSurface,
                shape: const CircleBorder(),
                child: InkWell(
                  customBorder: const CircleBorder(),
                  onTap: () => attachments.remove(item.id),
                  child: Tooltip(
                    message: 'Remove ${item.name}',
                    child: Padding(
                      padding: const EdgeInsets.all(3),
                      child: Icon(
                        Icons.close_rounded,
                        size: 14,
                        color: colors.onInverseSurface,
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}
