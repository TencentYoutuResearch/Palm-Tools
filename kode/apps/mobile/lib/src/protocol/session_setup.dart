/// Desktop-owned catalogues used when creating a mobile session.
class BackendOption {
  const BackendOption({
    required this.key,
    required this.label,
    this.modelFlag,
    this.bypassLabel,
  });
  final String key;
  final String label;
  final String? modelFlag;

  /// Name of the launch mode that skips every approval; null when unsupported.
  final String? bypassLabel;
  factory BackendOption.fromJson(Map<String, dynamic> json) => BackendOption(
    key: json['key'] as String,
    label: json['display_name'] as String? ?? json['key'] as String,
    modelFlag: json['model_flag'] as String?,
    bypassLabel: json['bypass_label'] as String?,
  );
}

class BackendCatalogue {
  const BackendCatalogue(this.backends, this.home);
  final List<BackendOption> backends;
  final String? home;
  factory BackendCatalogue.fromJson(Map<String, dynamic> json) =>
      BackendCatalogue(
        (json['backends'] as List? ?? [])
            .cast<Map<String, dynamic>>()
            .where((item) => item['enabled'] != false)
            .map(BackendOption.fromJson)
            .toList(),
        json['home'] as String?,
      );
}

class ModelOption {
  const ModelOption({required this.id, required this.label});
  final String id;
  final String label;
}

class ModelCatalogue {
  const ModelCatalogue(this.models, {this.customAllowed = true, this.warning});
  final List<ModelOption> models;
  final bool customAllowed;
  final String? warning;
  factory ModelCatalogue.fromJson(Map<String, dynamic> json) => ModelCatalogue(
    (json['models'] as List? ?? [])
        .map(
          (item) => ModelOption(
            id: item['id'] as String,
            label: item['label'] as String? ?? item['id'] as String,
          ),
        )
        .toList(),
    customAllowed: json['custom_allowed'] as bool? ?? true,
    warning: json['warning'] as String?,
  );
}

class DirectoryListing {
  const DirectoryListing({
    required this.path,
    this.parent,
    required this.entries,
    this.truncated = false,
  });
  final String path;
  final String? parent;
  final List<DirectoryOption> entries;
  final bool truncated;
  factory DirectoryListing.fromJson(Map<String, dynamic> json) =>
      DirectoryListing(
        path: json['path'] as String,
        parent: json['parent'] as String?,
        truncated: json['truncated'] as bool? ?? false,
        entries: (json['entries'] as List? ?? [])
            .where((item) => item['is_dir'] == true)
            .map(
              (item) => DirectoryOption(
                item['name'] as String,
                item['path'] as String,
              ),
            )
            .toList(),
      );
}

class DirectoryOption {
  const DirectoryOption(this.name, this.path);
  final String name;
  final String path;
}
