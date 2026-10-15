import 'package:flutter/material.dart';

import '../../api/api_client.dart';
import '../../protocol/session_setup.dart';
import '../glass.dart';
import 'project_path_tile.dart';

/// Selects a directory on the paired desktop, never the phone filesystem.
class DirectoryPickerScreen extends StatefulWidget {
  const DirectoryPickerScreen({super.key, required this.api, this.initialPath});
  final ApiClient api;
  final String? initialPath;
  @override
  State<DirectoryPickerScreen> createState() => _DirectoryPickerScreenState();
}

class _DirectoryPickerScreenState extends State<DirectoryPickerScreen> {
  final _path = TextEditingController();
  DirectoryListing? _listing;
  String? _error;
  bool _loading = false;
  bool _hidden = false;
  int _generation = 0;
  String? _requestedPath;

  @override
  void initState() {
    super.initState();
    _path.text = widget.initialPath ?? '';
    _load(widget.initialPath);
  }

  @override
  void dispose() {
    _path.dispose();
    super.dispose();
  }

  Future<void> _load(String? path) async {
    final generation = ++_generation;
    setState(() {
      _loading = true;
      _error = null;
      _requestedPath = path;
      if (path != null) _path.text = path;
    });
    try {
      final listing = await widget.api.listDirectories(
        path: path,
        showHidden: _hidden,
      );
      if (!mounted || generation != _generation) return;
      setState(() {
        _listing = listing;
        _path.text = listing.path;
      });
    } catch (error) {
      if (!mounted || generation != _generation) return;
      setState(() {
        _error = error is ApiException
            ? error.detail
            : 'Could not open this directory. Check the desktop connection and retry.';
      });
    } finally {
      if (mounted && generation == _generation) {
        setState(() => _loading = false);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    final listing = _listing;
    return GlassScaffold(
      appBar: GlassAppBar(
        title: const Text('Choose directory'),
        actions: [
          IconButton(
            tooltip: _hidden
                ? 'Hide hidden directories'
                : 'Show hidden directories',
            isSelected: _hidden,
            icon: const Icon(Icons.visibility_off_outlined),
            selectedIcon: const Icon(Icons.visibility_outlined),
            onPressed: _loading
                ? null
                : () {
                    setState(() => _hidden = !_hidden);
                    _load(_path.text.trim());
                  },
          ),
        ],
      ),
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 0),
              child: TextField(
                controller: _path,
                autocorrect: false,
                enableSuggestions: false,
                onChanged: (_) => setState(() {}),
                onSubmitted: _loading ? null : (value) => _load(value.trim()),
                decoration: InputDecoration(
                  labelText: 'Desktop path',
                  suffixIcon: IconButton(
                    tooltip: 'Open directory',
                    onPressed: _loading ? null : () => _load(_path.text.trim()),
                    icon: const Icon(Icons.arrow_forward),
                  ),
                ),
              ),
            ),
            if (listing != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(16, 12, 16, 8),
                child: Row(
                  children: [
                    IconButton.filledTonal(
                      tooltip: 'Parent directory',
                      onPressed: _loading || listing.parent == null
                          ? null
                          : () => _load(listing.parent),
                      icon: const Icon(Icons.arrow_upward_rounded),
                    ),
                    const SizedBox(width: 12),
                    Expanded(
                      child: Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Text(
                            directoryName(listing.path),
                            maxLines: 2,
                            overflow: TextOverflow.ellipsis,
                            style: Theme.of(context).textTheme.titleMedium,
                          ),
                          Text(
                            '${listing.entries.length}${listing.truncated ? '+' : ''} ${listing.entries.length == 1 ? 'folder' : 'folders'}',
                            style: Theme.of(context).textTheme.bodySmall,
                          ),
                        ],
                      ),
                    ),
                  ],
                ),
              ),
            SizedBox(
              height: 4,
              child: _loading ? const LinearProgressIndicator() : null,
            ),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.all(16),
                child: Column(
                  children: [
                    Text(
                      _error!,
                      style: TextStyle(
                        color: Theme.of(context).colorScheme.error,
                      ),
                    ),
                    TextButton(
                      onPressed: _loading ? null : () => _load(_requestedPath),
                      child: const Text('Retry'),
                    ),
                  ],
                ),
              ),
            Expanded(
              child: ListView(
                padding: const EdgeInsets.symmetric(
                  horizontal: 16,
                  vertical: 8,
                ),
                children: [
                  if (listing != null &&
                      listing.entries.isEmpty &&
                      !_loading &&
                      _error == null)
                    const Padding(
                      padding: EdgeInsets.all(24),
                      child: Text(
                        'No subdirectories. You can select this directory.',
                      ),
                    ),
                  if (listing?.truncated ?? false)
                    const Padding(
                      padding: EdgeInsets.all(16),
                      child: Text(
                        'Showing the first 160 directories. Enter a full path to open another directory.',
                      ),
                    ),
                  if (_error == null)
                    for (final entry in listing?.entries ?? <DirectoryOption>[])
                      ProjectPathTile(
                        path: entry.path,
                        title: entry.name,
                        showPath: false,
                        onTap: _loading ? null : () => _load(entry.path),
                      ),
                ],
              ),
            ),
            Padding(
              padding: const EdgeInsets.all(16),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.stretch,
                mainAxisSize: MainAxisSize.min,
                children: [
                  if (listing != null) ...[
                    Text(
                      'Selected directory',
                      style: Theme.of(context).textTheme.labelMedium,
                    ),
                    const SizedBox(height: 4),
                    ConstrainedBox(
                      constraints: const BoxConstraints(maxHeight: 76),
                      child: SingleChildScrollView(
                        child: SelectableText(
                          listing.path,
                          style: Theme.of(context).textTheme.bodySmall,
                        ),
                      ),
                    ),
                    const SizedBox(height: 12),
                  ],
                  FilledButton.icon(
                    onPressed:
                        _loading ||
                            _error != null ||
                            listing == null ||
                            _path.text.trim() != listing.path
                        ? null
                        : () => Navigator.of(context).pop(listing.path),
                    icon: const Icon(Icons.check),
                    label: const Text('Use this directory'),
                  ),
                ],
              ),
            ),
          ],
        ),
      ),
    );
  }
}
