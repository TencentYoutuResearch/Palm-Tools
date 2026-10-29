import 'package:flutter/material.dart';

String directoryName(String path) {
  final parts = path.split(RegExp(r'[/\\]')).where((p) => p.isNotEmpty);
  return parts.isEmpty ? path : parts.last;
}

/// Shared path presentation: recognizable directory name and exact location.
class ProjectPathTile extends StatelessWidget {
  const ProjectPathTile({
    super.key,
    required this.path,
    this.selected = false,
    this.onTap,
    this.title,
    this.showPath = true,
  });
  final String path;
  final String? title;
  final bool selected;
  final bool showPath;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return ListTile(
      selected: selected,
      selectedTileColor: colors.primary.withValues(alpha: .08),
      shape: RoundedRectangleBorder(borderRadius: BorderRadius.circular(14)),
      contentPadding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
      leading: Icon(
        selected ? Icons.folder_open_rounded : Icons.folder_outlined,
      ),
      title: Text(
        title ?? directoryName(path),
        style: const TextStyle(fontWeight: FontWeight.w600),
      ),
      subtitle: showPath
          ? Text(
              path,
              style: Theme.of(
                context,
              ).textTheme.bodySmall?.copyWith(color: colors.onSurfaceVariant),
            )
          : null,
      trailing: Icon(
        selected ? Icons.check_circle_rounded : Icons.chevron_right_rounded,
        size: 20,
      ),
      onTap: onTap,
    );
  }
}
