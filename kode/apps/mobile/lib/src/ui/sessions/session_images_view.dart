import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../state/providers.dart';
import '../../storage/session_images.dart';
import 'attachment_views.dart';

/// Thumbnails of the images a transcript event names. Each one is read from
/// the desktop on first view and opened full screen on tap.
class SessionImages extends StatelessWidget {
  final List<SessionImageRef> images;
  final WrapAlignment alignment;

  const SessionImages({
    super.key,
    required this.images,
    this.alignment = WrapAlignment.start,
  });

  @override
  Widget build(BuildContext context) {
    final side = images.length == 1 ? 200.0 : 96.0;
    return Wrap(
      alignment: alignment,
      spacing: 6,
      runSpacing: 6,
      children: [
        for (final image in images)
          _SessionImageTile(key: ValueKey(image.id), image: image, size: side),
      ],
    );
  }
}

class _SessionImageTile extends ConsumerStatefulWidget {
  final SessionImageRef image;
  final double size;

  const _SessionImageTile({super.key, required this.image, required this.size});

  @override
  ConsumerState<_SessionImageTile> createState() => _SessionImageTileState();
}

class _SessionImageTileState extends ConsumerState<_SessionImageTile> {
  late Future<File> _file;

  @override
  void initState() {
    super.initState();
    _file = _load();
  }

  Future<File> _load() {
    final api = ref.read(apiClientProvider);
    if (api == null) {
      return Future.error(ApiException(0, 'offline', 'Not connected'));
    }
    return SessionImageStore.instance.fetch(widget.image, api);
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final ratio = MediaQuery.devicePixelRatioOf(context);
    return FutureBuilder<File>(
      future: _file,
      builder: (context, snapshot) {
        final file = snapshot.data;
        final Widget child;
        final VoidCallback? onTap;
        final String label;
        if (file != null) {
          label = 'Open image';
          onTap = () => openImageViewer(
            context,
            path: file.path,
            name: widget.image.name,
          );
          child = Image.file(
            file,
            fit: BoxFit.cover,
            cacheWidth: (widget.size * ratio).round(),
            errorBuilder: (_, _, _) =>
                Icon(Icons.broken_image_outlined, color: colors.error),
          );
        } else if (snapshot.hasError) {
          final error = snapshot.error;
          final expired = error is ApiException && error.error == 'not_found';
          label = expired ? 'Image expired on the desktop' : 'Retry image';
          onTap = expired ? null : () => setState(() => _file = _load());
          child = Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              Icon(
                expired ? Icons.hide_image_outlined : Icons.refresh_rounded,
                color: colors.onSurfaceVariant,
              ),
              const SizedBox(height: 4),
              Text(
                expired ? 'Expired' : 'Tap to retry',
                style: TextStyle(fontSize: 11, color: colors.onSurfaceVariant),
              ),
            ],
          );
        } else {
          label = 'Loading image';
          onTap = null;
          child = Center(
            child: SizedBox.square(
              dimension: 18,
              child: CircularProgressIndicator(
                strokeWidth: 2,
                color: colors.primary,
              ),
            ),
          );
        }
        return Semantics(
          button: onTap != null,
          label: label,
          child: GestureDetector(
            onTap: onTap,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(12),
              child: Container(
                width: widget.size,
                height: widget.size,
                color: colors.surfaceContainerHighest,
                child: child,
              ),
            ),
          ),
        );
      },
    );
  }
}
