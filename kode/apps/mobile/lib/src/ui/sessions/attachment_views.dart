import 'dart:io';

import 'package:archive/archive_io.dart';
import 'package:flutter/material.dart';

import '../../protocol/attachments.dart';
import '../../storage/attachment_previews.dart';

IconData attachmentIcon(AttachmentKind kind) => switch (kind) {
  AttachmentKind.image => Icons.image_outlined,
  AttachmentKind.video => Icons.movie_outlined,
  AttachmentKind.archive => Icons.folder_zip_outlined,
  AttachmentKind.file => Icons.insert_drive_file_outlined,
};

String _extension(String name) {
  final dot = name.lastIndexOf('.');
  return dot < 0 ? '' : name.substring(dot + 1).toUpperCase();
}

/// Square tile: the image itself when a local copy exists, else a typed icon.
class AttachmentThumb extends StatelessWidget {
  final String name;
  final String? localPath;
  final double size;

  const AttachmentThumb({
    super.key,
    required this.name,
    required this.localPath,
    required this.size,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final kind = attachmentKindOf(name);
    final ratio = MediaQuery.devicePixelRatioOf(context);
    final fallback = Column(
      mainAxisAlignment: MainAxisAlignment.center,
      children: [
        Icon(attachmentIcon(kind), color: colors.onSurfaceVariant),
        if (_extension(name).isNotEmpty)
          Padding(
            padding: const EdgeInsets.only(top: 2),
            child: Text(
              _extension(name),
              maxLines: 1,
              overflow: TextOverflow.clip,
              style: TextStyle(fontSize: 9, color: colors.onSurfaceVariant),
            ),
          ),
      ],
    );
    return ClipRRect(
      borderRadius: BorderRadius.circular(12),
      child: Container(
        width: size,
        height: size,
        color: colors.surfaceContainerHighest,
        child: kind == AttachmentKind.image && localPath != null
            ? Image.file(
                File(localPath!),
                fit: BoxFit.cover,
                cacheWidth: (size * ratio).round(),
                errorBuilder: (_, _, _) => fallback,
              )
            : fallback,
      ),
    );
  }
}

/// Attachments named by a sent message. Files this phone attached recently
/// show their local preview; others show the name only.
class MessageAttachments extends StatefulWidget {
  final List<AttachmentReference> attachments;

  const MessageAttachments({super.key, required this.attachments});

  @override
  State<MessageAttachments> createState() => _MessageAttachmentsState();
}

class _MessageAttachmentsState extends State<MessageAttachments> {
  final _store = AttachmentPreviewStore.instance;

  @override
  void initState() {
    super.initState();
    _store.addListener(_changed);
    _store.ensureLoaded();
  }

  @override
  void dispose() {
    _store.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final images = <Widget>[];
    final files = <Widget>[];
    for (final ref in widget.attachments) {
      final preview = _store.lookup(ref.path);
      void open() => preview == null
          ? _showRemoteOnly(context, ref)
          : openLocalAttachment(
              context,
              path: preview.localPath,
              name: preview.name,
              size: preview.size,
            );
      if (ref.kind == AttachmentKind.image && preview != null) {
        images.add(
          Semantics(
            button: true,
            label: 'Open ${ref.name}',
            child: GestureDetector(
              onTap: open,
              child: AttachmentThumb(
                name: ref.name,
                localPath: preview.localPath,
                size: 96,
              ),
            ),
          ),
        );
        continue;
      }
      files.add(
        Material(
          color: colors.surfaceContainerHighest,
          borderRadius: BorderRadius.circular(12),
          child: InkWell(
            borderRadius: BorderRadius.circular(12),
            onTap: open,
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Icon(
                    attachmentIcon(ref.kind),
                    size: 20,
                    color: colors.primary,
                  ),
                  const SizedBox(width: 8),
                  Flexible(
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Text(
                          ref.name,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: const TextStyle(fontSize: 13),
                        ),
                        Text(
                          preview == null
                              ? 'On desktop'
                              : formatAttachmentSize(preview.size),
                          style: TextStyle(
                            fontSize: 11,
                            color: colors.onSurfaceVariant,
                          ),
                        ),
                      ],
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.end,
      mainAxisSize: MainAxisSize.min,
      children: [
        if (images.isNotEmpty)
          Wrap(
            alignment: WrapAlignment.end,
            spacing: 6,
            runSpacing: 6,
            children: images,
          ),
        if (images.isNotEmpty && files.isNotEmpty) const SizedBox(height: 6),
        for (final file in files)
          Padding(padding: const EdgeInsets.only(bottom: 4), child: file),
      ],
    );
  }
}

void _showRemoteOnly(BuildContext context, AttachmentReference ref) {
  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    builder: (context) => SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(20, 0, 20, 20),
        child: _FileHeader(
          name: ref.name,
          detail:
              'The preview on this phone has expired. '
              'The file is still on the desktop:\n${ref.path}',
          kind: ref.kind,
        ),
      ),
    ),
  );
}

/// Opens this phone's copy: images full screen, zip archives as a listing,
/// anything else as a summary.
void openLocalAttachment(
  BuildContext context, {
  required String path,
  required String name,
  required int size,
}) {
  final kind = attachmentKindOf(name);
  if (kind == AttachmentKind.image) {
    Navigator.of(context).push(
      MaterialPageRoute<void>(
        fullscreenDialog: true,
        builder: (_) => _ImageViewer(path: path, name: name),
      ),
    );
    return;
  }
  showModalBottomSheet<void>(
    context: context,
    showDragHandle: true,
    isScrollControlled: true,
    builder: (context) => DraggableScrollableSheet(
      expand: false,
      initialChildSize: name.toLowerCase().endsWith('.zip') ? 0.6 : 0.3,
      maxChildSize: 0.9,
      builder: (context, scroll) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(20, 0, 20, 12),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              _FileHeader(
                name: name,
                detail: formatAttachmentSize(size),
                kind: kind,
              ),
              if (name.toLowerCase().endsWith('.zip'))
                Expanded(
                  child: _ZipListing(path: path, scroll: scroll),
                ),
            ],
          ),
        ),
      ),
    ),
  );
}

class _FileHeader extends StatelessWidget {
  final String name;
  final String detail;
  final AttachmentKind kind;

  const _FileHeader({
    required this.name,
    required this.detail,
    required this.kind,
  });

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        Icon(attachmentIcon(kind), size: 32, color: colors.primary),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: Theme.of(context).textTheme.titleMedium),
              const SizedBox(height: 4),
              SelectableText(
                detail,
                style: TextStyle(color: colors.onSurfaceVariant, fontSize: 13),
              ),
            ],
          ),
        ),
      ],
    );
  }
}

class _ZipListing extends StatefulWidget {
  final String path;
  final ScrollController scroll;

  const _ZipListing({required this.path, required this.scroll});

  @override
  State<_ZipListing> createState() => _ZipListingState();
}

class _ZipListingState extends State<_ZipListing> {
  late final Future<List<({String name, int size})>> _entries = _read();

  // Reads the central directory only; entry contents stay compressed.
  Future<List<({String name, int size})>> _read() async {
    final input = InputFileStream(widget.path);
    try {
      final archive = ZipDecoder().decodeStream(input);
      return [
        for (final file in archive.files)
          if (file.isFile) (name: file.name, size: file.size),
      ];
    } finally {
      await input.close();
    }
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return FutureBuilder(
      future: _entries,
      builder: (context, snapshot) {
        if (snapshot.hasError) {
          return Padding(
            padding: const EdgeInsets.only(top: 16),
            child: Text(
              'Could not read this archive.',
              style: TextStyle(color: colors.error),
            ),
          );
        }
        final entries = snapshot.data;
        if (entries == null) {
          return const Center(child: CircularProgressIndicator());
        }
        return ListView.builder(
          controller: widget.scroll,
          padding: const EdgeInsets.only(top: 12),
          itemCount: entries.length + 1,
          itemBuilder: (context, index) {
            if (index == 0) {
              return Padding(
                padding: const EdgeInsets.only(bottom: 6),
                child: Text(
                  '${entries.length} files',
                  style: Theme.of(context).textTheme.labelLarge,
                ),
              );
            }
            final entry = entries[index - 1];
            return ListTile(
              dense: true,
              contentPadding: EdgeInsets.zero,
              leading: Icon(
                attachmentIcon(attachmentKindOf(entry.name)),
                size: 18,
              ),
              title: Text(
                entry.name,
                style: const TextStyle(fontFamily: 'Menlo', fontSize: 12),
              ),
              trailing: Text(
                formatAttachmentSize(entry.size),
                style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
              ),
            );
          },
        );
      },
    );
  }
}

class _ImageViewer extends StatelessWidget {
  final String path;
  final String name;

  const _ImageViewer({required this.path, required this.name});

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      backgroundColor: Colors.black,
      appBar: AppBar(
        backgroundColor: Colors.black,
        foregroundColor: Colors.white,
        title: Text(name, overflow: TextOverflow.ellipsis),
      ),
      body: InteractiveViewer(
        maxScale: 6,
        child: Center(child: Image.file(File(path))),
      ),
    );
  }
}
