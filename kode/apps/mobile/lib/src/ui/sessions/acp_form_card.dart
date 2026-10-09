import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import '../../state/providers.dart';

/// Owns a complete typed form. Responses are sent atomically on the ACP
/// connection; no terminal cursor position or synthetic chat message is used.
class AcpFormCard extends ConsumerStatefulWidget {
  final int sessionId;
  final Map<String, dynamic> payload;
  AcpFormCard({required this.sessionId, required this.payload})
    : super(key: ValueKey('acp-form-${payload['request_id']}'));
  @override
  ConsumerState<AcpFormCard> createState() => _AcpFormCardState();
}

class _AcpFormCardState extends ConsumerState<AcpFormCard> {
  static final _customChoice = Object();
  final _form = GlobalKey<FormState>();
  final Map<String, dynamic> _values = {};
  final Set<String> _custom = {};
  bool _sending = false;
  String? _action;
  String? _error;
  Map<String, dynamic> get _schema =>
      Map<String, dynamic>.from(widget.payload['requested_schema'] as Map);
  Map<String, dynamic> get _properties =>
      Map<String, dynamic>.from(_schema['properties'] as Map);
  Set<String> get _required =>
      ((_schema['required'] as List?) ?? []).cast<String>().toSet();
  @override
  void initState() {
    super.initState();
    for (final entry in _properties.entries) {
      final p = entry.value as Map;
      if (p.containsKey('default')) _values[entry.key] = p['default'];
    }
  }

  List<dynamic> _choices(Map<String, dynamic> p) =>
      (p['enum'] as List?) ??
      ((p['oneOf'] as List?)?.map((item) => (item as Map)['const']).toList()) ??
      [];
  String _label(Map<String, dynamic> p, dynamic value) {
    for (final item in (p['oneOf'] as List?) ?? []) {
      if ((item as Map)['const'] == value) return '${item['title'] ?? value}';
    }
    final enums = (p['enum'] as List?) ?? [];
    final names = (p['enumNames'] as List?) ?? [];
    final index = enums.indexOf(value);
    return index >= 0 && index < names.length ? '${names[index]}' : '$value';
  }

  Widget _field(String key, Map<String, dynamic> p) {
    final required = _required.contains(key);
    final label = '${p['title'] ?? key}${required ? ' *' : ''}';
    final locked =
        _sending || _action != null || widget.payload['resolved'] == true;
    final colors = Theme.of(context).colorScheme;
    final choices = _choices(p);
    Widget field;
    if (p['type'] == 'array') {
      final items = Map<String, dynamic>.from(p['items'] as Map);
      field = FormField<List<dynamic>>(
        validator: (_) {
          final count = (_values[key] as List?)?.length ?? 0;
          final min = (p['minItems'] as num?)?.toInt() ?? (required ? 1 : 0);
          final max = (p['maxItems'] as num?)?.toInt();
          if (count < min) return 'Select at least $min';
          if (max != null && count > max) return 'Select at most $max';
          return null;
        },
        builder: (state) => Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              label,
              style: TextStyle(
                color: colors.onSurface,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 8),
            Wrap(
              spacing: 8,
              runSpacing: 4,
              children: _choices(items).map((option) {
                final values = (_values[key] as List?)?.toList() ?? [];
                return FilterChip(
                  label: Text(_label(items, option)),
                  selected: values.contains(option),
                  onSelected: locked
                      ? null
                      : (selected) {
                          if (selected) {
                            values.add(option);
                          } else {
                            values.remove(option);
                          }
                          setState(() => _values[key] = values);
                          state.didChange(values);
                        },
                );
              }).toList(),
            ),
            if (state.errorText != null)
              Text(state.errorText!, style: TextStyle(color: colors.error)),
          ],
        ),
      );
    } else if (p['type'] == 'boolean' || choices.isNotEmpty) {
      final options = p['type'] == 'boolean' ? [true, false] : choices;
      field = Column(
        children: [
          DropdownButtonFormField<Object>(
            initialValue: _custom.contains(key) ? _customChoice : _values[key],
            isExpanded: true,
            decoration: InputDecoration(labelText: label),
            items: [
              for (final value in options)
                DropdownMenuItem(
                  value: value as Object,
                  child: Text(
                    p['type'] == 'boolean'
                        ? (value == true ? 'Yes' : 'No')
                        : _label(p, value),
                    maxLines: 3,
                    overflow: TextOverflow.ellipsis,
                  ),
                ),
              if (p['allow_custom'] == true)
                DropdownMenuItem(
                  value: _customChoice,
                  child: const Text('Your own answer'),
                ),
            ],
            onChanged: locked
                ? null
                : (value) => setState(() {
                    if (p['allow_custom'] == true && value == _customChoice) {
                      _custom.add(key);
                      _values.remove(key);
                    } else {
                      _custom.remove(key);
                      _values[key] = value;
                    }
                  }),
            validator: (_) =>
                required && !_values.containsKey(key) && !_custom.contains(key)
                ? 'Choose an answer'
                : null,
          ),
          if (_custom.contains(key)) ...[
            const SizedBox(height: 8),
            TextFormField(
              key: ValueKey('custom-$key'),
              enabled: !locked,
              minLines: 1,
              maxLines: 4,
              decoration: const InputDecoration(labelText: 'Your own answer'),
              onChanged: (value) => _values[key] = value,
              validator: (value) => value == null || value.trim().isEmpty
                  ? 'Enter your answer'
                  : null,
            ),
          ],
        ],
      );
    } else {
      final numeric = p['type'] == 'integer' || p['type'] == 'number';
      field = TextFormField(
        key: ValueKey('field-$key'),
        initialValue: _values[key]?.toString(),
        enabled: !locked,
        keyboardType: numeric
            ? const TextInputType.numberWithOptions(decimal: true, signed: true)
            : TextInputType.multiline,
        minLines: 1,
        maxLines: numeric ? 1 : 4,
        decoration: InputDecoration(labelText: label),
        onChanged: (text) {
          if (text.isEmpty && !required) {
            _values.remove(key);
          } else {
            _values[key] = numeric
                ? (p['type'] == 'integer'
                      ? int.tryParse(text)
                      : num.tryParse(text))
                : text;
          }
        },
        validator: (text) {
          if (text == null || text.isEmpty) {
            return required ? 'Enter an answer' : null;
          }
          if (numeric) {
            final value = p['type'] == 'integer'
                ? int.tryParse(text)
                : num.tryParse(text);
            if (value == null || !value.isFinite) {
              return 'Enter a valid ${p['type']}';
            }
            if (p['minimum'] is num && value < (p['minimum'] as num)) {
              return 'Minimum: ${p['minimum']}';
            }
            if (p['maximum'] is num && value > (p['maximum'] as num)) {
              return 'Maximum: ${p['maximum']}';
            }
          } else {
            final length = text.runes.length;
            if (p['minLength'] is num && length < (p['minLength'] as num)) {
              return 'Enter at least ${p['minLength']} characters';
            }
            if (p['maxLength'] is num && length > (p['maxLength'] as num)) {
              return 'Enter at most ${p['maxLength']} characters';
            }
          }
          return null;
        },
      );
    }
    return Padding(
      padding: const EdgeInsets.only(bottom: 18),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          field,
          if (p['description'] is String) ...[
            const SizedBox(height: 6),
            Text(
              p['description'] as String,
              style: TextStyle(color: colors.onSurfaceVariant, height: 1.4),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final locked =
        _sending || _action != null || widget.payload['resolved'] == true;
    return Container(
      margin: const EdgeInsets.symmetric(vertical: 8),
      padding: const EdgeInsets.all(16),
      decoration: BoxDecoration(
        color: colors.surface,
        borderRadius: BorderRadius.circular(22),
        border: Border.all(color: colors.outlineVariant),
      ),
      child: Form(
        key: _form,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(
              '${widget.payload['agent'] ?? 'Agent'} · Question',
              style: TextStyle(
                color: colors.primary,
                fontWeight: FontWeight.w700,
              ),
            ),
            const SizedBox(height: 12),
            Text(
              widget.payload['question'] as String? ?? '',
              style: TextStyle(
                color: colors.onSurface,
                fontSize: 16,
                height: 1.45,
              ),
            ),
            const SizedBox(height: 20),
            for (final entry in _properties.entries)
              _field(entry.key, Map<String, dynamic>.from(entry.value as Map)),
            if (_error != null)
              Padding(
                padding: const EdgeInsets.only(bottom: 12),
                child: Text(_error!, style: TextStyle(color: colors.error)),
              ),
            SizedBox(
              width: double.infinity,
              child: FilledButton(
                onPressed: locked ? null : () => _send('accept'),
                child: Text(
                  _sending
                      ? 'Submitting…'
                      : _action == null
                      ? 'Submit answers'
                      : 'Response sent: $_action',
                ),
              ),
            ),
            Wrap(
              spacing: 12,
              children: [
                TextButton(
                  onPressed: locked ? null : () => _send('decline'),
                  child: const Text('Decline'),
                ),
                TextButton(
                  onPressed: locked ? null : () => _send('cancel'),
                  child: const Text('Cancel'),
                ),
              ],
            ),
          ],
        ),
      ),
    );
  }

  Future<void> _send(String action) async {
    if (_sending || _action != null || widget.payload['resolved'] == true) {
      return;
    }
    if (action == 'accept' && !(_form.currentState?.validate() ?? false)) {
      return;
    }
    final api = ref.read(apiClientProvider);
    if (api == null) return;
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final native = widget.payload['source'] == 'acp_questions';
      final response = native
          ? <String, dynamic>{
              'decision': action == 'accept' ? 'allow' : 'deny',
              if (action == 'accept')
                'content': Map<String, dynamic>.from(_values),
            }
          : <String, dynamic>{
              'action': action,
              if (action == 'accept')
                'content': Map<String, dynamic>.from(_values),
            };
      await api.postStructuredResponse(
        widget.sessionId,
        widget.payload['request_id'] as String,
        response,
      );
      if (mounted) setState(() => _action = action);
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }
}
