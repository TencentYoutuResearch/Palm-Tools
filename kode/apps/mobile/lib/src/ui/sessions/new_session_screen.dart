import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/api_client.dart';
import '../../protocol/session_setup.dart';
import '../../state/providers.dart';
import '../glass.dart';
import 'directory_picker_screen.dart';
import 'project_path_tile.dart';

class NewSessionScreen extends ConsumerStatefulWidget {
  const NewSessionScreen({super.key});
  @override
  ConsumerState<NewSessionScreen> createState() => _NewSessionScreenState();
}

class _NewSessionScreenState extends ConsumerState<NewSessionScreen> {
  final _form = GlobalKey<FormState>();
  final _cwd = TextEditingController();
  final _customModel = TextEditingController();
  final _cwdFocus = FocusNode();
  final _modelFocus = FocusNode();
  ApiClient? _api;
  BackendCatalogue? _catalogue;
  BackendOption? _backend;
  ModelCatalogue? _models;
  String _model = '';
  bool _custom = false;
  bool _bypass = false;
  bool _loading = true;
  bool _loadingModels = false;
  bool _submitting = false;
  bool _uncertain = false;
  bool _dirty = false;
  bool _allowPop = false;
  String? _loadError;
  String? _modelError;
  String? _submitError;
  String? _requestId;
  int _modelGeneration = 0;

  bool get _locked => _submitting || _uncertain;
  bool get _current => mounted && identical(_api, ref.read(apiClientProvider));

  @override
  void initState() {
    super.initState();
    _api = ref.read(apiClientProvider);
    unawaited(_load());
  }

  @override
  void dispose() {
    _cwd.dispose();
    _customModel.dispose();
    _cwdFocus.dispose();
    _modelFocus.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    setState(() {
      _loading = true;
      _loadError = null;
    });
    try {
      final api = _api;
      if (api == null) throw StateError('No desktop selected');
      final catalogue = await api.listBackends();
      if (!_current) return;
      setState(() {
        _catalogue = catalogue;
        _backend = catalogue.backends.firstOrNull;
        if (_cwd.text.isEmpty) _cwd.text = catalogue.home ?? '';
      });
      if (_backend != null) unawaited(_loadModels());
    } catch (error) {
      if (!_current) return;
      setState(
        () => _loadError = _errorText(
          error,
          'Could not load backends. Check the desktop connection and retry.',
        ),
      );
    } finally {
      if (_current) setState(() => _loading = false);
    }
  }

  Future<void> _loadModels() async {
    final generation = ++_modelGeneration;
    final backend = _backend;
    setState(() {
      _models = null;
      _model = '';
      _custom = false;
      _customModel.clear();
      _modelError = null;
      _loadingModels = backend?.modelFlag != null;
    });
    if (backend == null || backend.modelFlag == null) return;
    try {
      final result = await _api!.listModels(backend.key);
      if (!_current || generation != _modelGeneration) return;
      setState(() => _models = result);
    } catch (error) {
      if (!_current || generation != _modelGeneration) return;
      setState(
        () => _modelError = _errorText(
          error,
          'Could not load models. Use the backend default or enter a model ID.',
        ),
      );
    } finally {
      if (_current && generation == _modelGeneration) {
        setState(() => _loadingModels = false);
      }
    }
  }

  String _errorText(Object error, String fallback) {
    if (error is ApiException) {
      if (error.status == 404 || error.status == 405) {
        return 'Update the desktop app and sync server to enable session creation.';
      }
      if (error.detail.isNotEmpty) return error.detail;
    }
    return fallback;
  }

  Future<void> _browse() async {
    final path = await Navigator.of(context).push<String>(
      MaterialPageRoute(
        builder: (_) =>
            DirectoryPickerScreen(api: _api!, initialPath: _cwd.text.trim()),
      ),
    );
    if (!_current || path == null) return;
    setState(() {
      _cwd.text = path;
      _dirty = true;
    });
  }

  Future<void> _create() async {
    if (_submitting || _backend == null || !_current) return;
    if (!_form.currentState!.validate()) {
      (_custom && _customModel.text.trim().isEmpty ? _modelFocus : _cwdFocus)
          .requestFocus();
      return;
    }
    FocusScope.of(context).unfocus();
    setState(() {
      _submitting = true;
      _submitError = null;
    });
    _requestId ??= ApiClient.newRequestId();
    try {
      final model = _custom ? _customModel.text.trim() : _model;
      final session = await _api!.createSession(
        backendKey: _backend!.key,
        cwd: _cwd.text.trim(),
        model: model.isEmpty ? null : model,
        permissionMode: _bypass && _backend!.bypassLabel != null
            ? 'bypass'
            : null,
        requestId: _requestId,
      );
      if (!_current) return;
      unawaited(
        ref.read(sessionsProvider.notifier).refresh(showLoading: false),
      );
      setState(() => _allowPop = true);
      if (mounted) context.replace('/sessions/${session.id}');
    } catch (error) {
      if (!_current) return;
      // Transport failure does not prove the desktop failed to create it.
      final uncertain =
          error is! ApiException ||
          error.error == 'creation_unconfirmed' ||
          error.status >= 500;
      setState(() {
        _uncertain = uncertain;
        _submitError = uncertain
            ? 'Creation result is not confirmed. Check again to retrieve the same request, or check the session list before creating another.'
            : _errorText(
                error,
                'Could not create this session. Check your selections and retry.',
              );
        if (!uncertain) _requestId = null;
      });
    } finally {
      if (_current) setState(() => _submitting = false);
    }
  }

  Future<void> _confirmLeave() async {
    if (_submitting) return;
    final leave = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          _uncertain ? 'Check the session list?' : 'Discard session setup?',
        ),
        content: Text(
          _uncertain
              ? 'The desktop may have created this session. Check the list before starting another.'
              : 'Your backend, model and path selections will be discarded.',
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context, false),
            child: const Text('Keep editing'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context, true),
            child: Text(_uncertain ? 'Check sessions' : 'Discard'),
          ),
        ],
      ),
    );
    if (!mounted || leave != true) return;
    setState(() => _allowPop = true);
    if (_uncertain) {
      unawaited(
        ref.read(sessionsProvider.notifier).refresh(showLoading: false),
      );
    }
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) context.pop();
    });
  }

  @override
  Widget build(BuildContext context) {
    ref.listen(endpointProvider, (previous, next) {
      if (previous != next) context.go('/sessions');
    });
    final colors = Theme.of(context).colorScheme;
    final recentPaths = (ref.watch(sessionsProvider).value ?? [])
        .map((session) => session.cwd)
        .whereType<String>()
        .where((path) => path.isNotEmpty)
        .toSet()
        .take(6);
    return PopScope(
      canPop: _allowPop || (!_dirty && !_locked),
      onPopInvokedWithResult: (didPop, _) {
        if (!didPop) unawaited(_confirmLeave());
      },
      child: GlassScaffold(
        appBar: const GlassAppBar(title: Text('New session')),
        body: SafeArea(
          child: _loading
              ? const Center(child: CircularProgressIndicator())
              : ListView(
                  padding: const EdgeInsets.all(16),
                  children: [
                    Text(
                      'On ${ref.watch(endpointProvider)?.deviceName ?? 'your desktop'}',
                      style: Theme.of(context).textTheme.titleMedium,
                    ),
                    const SizedBox(height: 16),
                    if (_loadError != null) ...[
                      Text(_loadError!, style: TextStyle(color: colors.error)),
                      TextButton(onPressed: _load, child: const Text('Retry')),
                    ] else if (_catalogue?.backends.isEmpty ?? true) ...[
                      const Text(
                        'No available backends. Install and enable a backend on the desktop, then refresh.',
                      ),
                      TextButton(
                        onPressed: _load,
                        child: const Text('Refresh'),
                      ),
                    ] else
                      Form(
                        key: _form,
                        child: GlassSurface(
                          padding: const EdgeInsets.all(16),
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.stretch,
                            children: [
                              DropdownButtonFormField<String>(
                                initialValue: _backend?.key,
                                isExpanded: true,
                                decoration: const InputDecoration(
                                  labelText: 'Backend',
                                ),
                                items: [
                                  for (final backend in _catalogue!.backends)
                                    DropdownMenuItem(
                                      value: backend.key,
                                      child: Text(
                                        backend.label,
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                ],
                                onChanged: _locked
                                    ? null
                                    : (key) {
                                        setState(() {
                                          _backend = _catalogue!.backends
                                              .firstWhere((b) => b.key == key);
                                          _dirty = true;
                                        });
                                        unawaited(_loadModels());
                                      },
                              ),
                              const SizedBox(height: 20),
                              if (_backend?.modelFlag != null) ...[
                                if (_loadingModels)
                                  const LinearProgressIndicator(),
                                DropdownButtonFormField<String>(
                                  key: ValueKey(
                                    '${_backend?.key}:$_custom:$_model:$_loadingModels',
                                  ),
                                  initialValue: _custom ? '__custom__' : _model,
                                  isExpanded: true,
                                  decoration: const InputDecoration(
                                    labelText: 'Model',
                                  ),
                                  items: [
                                    const DropdownMenuItem(
                                      value: '',
                                      child: Text('Backend default'),
                                    ),
                                    for (final model in {
                                      for (final m
                                          in _models?.models ?? <ModelOption>[])
                                        if (m.id.isNotEmpty &&
                                            m.id != '__custom__')
                                          m.id: m,
                                    }.values)
                                      DropdownMenuItem(
                                        value: model.id,
                                        child: Text(
                                          model.label,
                                          overflow: TextOverflow.ellipsis,
                                        ),
                                      ),
                                    if (!_loadingModels &&
                                        (_models?.customAllowed ?? true))
                                      const DropdownMenuItem(
                                        value: '__custom__',
                                        child: Text('Custom model…'),
                                      ),
                                  ],
                                  onChanged: _locked || _loadingModels
                                      ? null
                                      : (value) => setState(() {
                                          _custom = value == '__custom__';
                                          _model = _custom ? '' : value ?? '';
                                          _dirty = true;
                                        }),
                                ),
                                if (_custom)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 12),
                                    child: TextFormField(
                                      controller: _customModel,
                                      focusNode: _modelFocus,
                                      enabled: !_locked,
                                      autocorrect: false,
                                      decoration: const InputDecoration(
                                        labelText: 'Model ID',
                                      ),
                                      onChanged: (_) =>
                                          setState(() => _dirty = true),
                                      validator: (value) =>
                                          _custom &&
                                              (value?.trim().isEmpty ?? true)
                                          ? 'Enter a model ID.'
                                          : null,
                                    ),
                                  ),
                                if (_modelError != null) ...[
                                  Text(
                                    _modelError!,
                                    style: TextStyle(color: colors.error),
                                  ),
                                  TextButton(
                                    onPressed: _locked ? null : _loadModels,
                                    child: const Text('Reload models'),
                                  ),
                                ],
                                if (_models?.warning != null)
                                  Text(_models!.warning!),
                                const SizedBox(height: 20),
                              ],
                              if (_backend?.bypassLabel != null) ...[
                                SwitchListTile(
                                  key: const ValueKey('new-session-bypass'),
                                  contentPadding: EdgeInsets.zero,
                                  value: _bypass,
                                  title: Text(_backend!.bypassLabel!),
                                  subtitle: const Text(
                                    'Skip permission prompts. You can change this later in the session.',
                                  ),
                                  onChanged: _locked
                                      ? null
                                      : (value) => setState(() {
                                          _bypass = value;
                                          _dirty = true;
                                        }),
                                ),
                                const SizedBox(height: 12),
                              ],
                              TextFormField(
                                controller: _cwd,
                                focusNode: _cwdFocus,
                                enabled: !_locked,
                                autocorrect: false,
                                enableSuggestions: false,
                                decoration: InputDecoration(
                                  labelText: 'Working directory',
                                  helperText:
                                      'Absolute path on the selected desktop',
                                  helperMaxLines: 2,
                                  suffixIcon: IconButton(
                                    tooltip: 'Browse desktop directories',
                                    onPressed: _locked ? null : _browse,
                                    icon: const Icon(Icons.folder_open),
                                  ),
                                ),
                                onChanged: (_) => setState(() => _dirty = true),
                                validator: (value) {
                                  final path = value?.trim() ?? '';
                                  if (!path.startsWith('/') &&
                                      !RegExp(
                                        r'^[A-Za-z]:[\\/]',
                                      ).hasMatch(path)) {
                                    return 'Choose or enter an absolute desktop path.';
                                  }
                                  return null;
                                },
                              ),
                              if (recentPaths.isNotEmpty) ...[
                                const SizedBox(height: 12),
                                Text(
                                  'Existing projects',
                                  style: Theme.of(context).textTheme.titleSmall,
                                ),
                                const SizedBox(height: 8),
                                GlassSurface(
                                  radius: 16,
                                  child: Column(
                                    children: [
                                      for (final path in recentPaths)
                                        ProjectPathTile(
                                          path: path,
                                          selected: _cwd.text.trim() == path,
                                          onTap: _locked
                                              ? null
                                              : () => setState(() {
                                                  _cwd.text = path;
                                                  _dirty = true;
                                                }),
                                        ),
                                    ],
                                  ),
                                ),
                              ],
                              const SizedBox(height: 20),
                              if (_submitError != null)
                                Padding(
                                  padding: const EdgeInsets.only(bottom: 12),
                                  child: Semantics(
                                    liveRegion: true,
                                    child: Text(
                                      _submitError!,
                                      style: TextStyle(color: colors.error),
                                    ),
                                  ),
                                ),
                              FilledButton.icon(
                                onPressed: _submitting ? null : _create,
                                icon: _submitting
                                    ? const SizedBox(
                                        width: 18,
                                        height: 18,
                                        child: CircularProgressIndicator(
                                          strokeWidth: 2,
                                        ),
                                      )
                                    : const Icon(Icons.add),
                                label: Text(
                                  _uncertain
                                      ? 'Check creation result'
                                      : 'Create session',
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                  ],
                ),
        ),
      ),
    );
  }
}
