import 'package:flutter/material.dart';
import '../../protocol/session_setup.dart';

/// Select a desktop-discovered model without changing or discarding the draft.
class SessionModelSheet extends StatefulWidget {
  const SessionModelSheet({
    super.key,
    required this.currentModel,
    required this.load,
  });
  final String currentModel;
  final Future<ModelCatalogue> Function() load;

  @override
  State<SessionModelSheet> createState() => _SessionModelSheetState();
}

class _SessionModelSheetState extends State<SessionModelSheet> {
  late Future<ModelCatalogue> _models = widget.load();

  @override
  Widget build(BuildContext context) => SafeArea(
    child: SizedBox(
      height: MediaQuery.sizeOf(context).height * .6,
      child: Column(
        children: [
          ListTile(
            title: const Text('Switch model'),
            subtitle: const Text(
              'Continue this conversation with another model',
            ),
            trailing: IconButton(
              tooltip: 'Close',
              onPressed: () => Navigator.pop(context),
              icon: const Icon(Icons.close),
            ),
          ),
          Expanded(
            child: FutureBuilder<ModelCatalogue>(
              future: _models,
              builder: (context, snapshot) {
                if (snapshot.connectionState != ConnectionState.done) {
                  return const Center(child: CircularProgressIndicator());
                }
                if (snapshot.hasError) {
                  return Center(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Text('Could not load models from the desktop.'),
                        TextButton(
                          onPressed: () =>
                              setState(() { _models = widget.load(); }),
                          child: const Text('Retry'),
                        ),
                      ],
                    ),
                  );
                }
                final catalogue = snapshot.requireData;
                if (catalogue.models.isEmpty) {
                  return const Center(
                    child: Text('No models available from this backend.'),
                  );
                }
                return ListView(
                  children: [
                    if (catalogue.warning != null)
                      Padding(
                        padding: const EdgeInsets.all(16),
                        child: Text(catalogue.warning!),
                      ),
                    for (final model in catalogue.models)
                      ListTile(
                        title: Text(model.label),
                        subtitle: model.label == model.id
                            ? null
                            : Text(model.id),
                        selected: model.id == widget.currentModel,
                        trailing: model.id == widget.currentModel
                            ? const Icon(Icons.check)
                            : null,
                        onTap: () => Navigator.pop(context, model.id),
                      ),
                  ],
                );
              },
            ),
          ),
        ],
      ),
    ),
  );
}
