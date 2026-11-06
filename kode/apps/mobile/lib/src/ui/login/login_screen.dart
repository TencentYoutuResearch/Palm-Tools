// Kode account sign-in and palm sign-up. The relay lists the methods it
// offers (palm scan in Kode's own palm library, email code, later
// WeChat/Google); this screen shows exactly those this device can run.
// Signed-in phones see every desktop of the account without scanning a QR.
import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:go_router/go_router.dart';

import '../../api/account_client.dart';
import '../../api/api_client.dart';
import '../../state/providers.dart';
import '../glass.dart';
import '../palm/palm_capture_screen.dart';

class LoginScreen extends ConsumerStatefulWidget {
  const LoginScreen({super.key});

  @override
  ConsumerState<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends ConsumerState<LoginScreen> {
  final _serverCtrl = TextEditingController(text: defaultRelayUrl);
  final _emailCtrl = TextEditingController();
  final _codeCtrl = TextEditingController();
  List<LoginMethod> _methods = const [];
  LoginMethod? _method;
  PendingSignIn? _pending;
  bool _editRelay = false;
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    if (defaultRelayUrl.isEmpty) {
      _editRelay = true;
    } else {
      _loadMethods();
    }
  }

  @override
  void dispose() {
    _serverCtrl.dispose();
    _emailCtrl.dispose();
    _codeCtrl.dispose();
    super.dispose();
  }

  String get _server => AccountClient.normalizeServerUrl(_serverCtrl.text);

  Future<void> _run(Future<void> Function() action) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on ApiException catch (error) {
      if (mounted) setState(() => _error = error.detail);
    } on DioException catch (_) {
      if (mounted) {
        setState(
          () => _error =
              'Cannot reach the account relay. Check its HTTPS URL and your network.',
        );
      }
    } catch (error) {
      if (mounted) setState(() => _error = '$error');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _checkRelay() {
    final uri = Uri.tryParse(_server);
    if (uri == null || uri.scheme != 'https' || uri.host.isEmpty) {
      throw ApiException(0, 'bad_url', 'Enter the relay\'s https:// address.');
    }
  }

  Future<void> _loadMethods() => _run(() async {
    _checkRelay();
    var methods = await ref.read(accountClientProvider).loginMethods(_server);
    if (methods.contains(LoginMethod.palm) && !await palmCaptureSupported()) {
      methods = methods.where((m) => m != LoginMethod.palm).toList();
    }
    if (!mounted) return;
    setState(() {
      _methods = methods;
      _method = methods.contains(_method) ? _method : methods.firstOrNull;
      _editRelay = false;
    });
  });

  // ---- email ----
  Future<void> _sendCode() => _run(() async {
    _checkRelay();
    if (!RegExp(
      r'^[^\s@]+@[^\s@]+\.[^\s@]+$',
    ).hasMatch(_emailCtrl.text.trim())) {
      throw ApiException(0, 'bad_email', 'Enter a valid email address.');
    }
    final pending = await ref
        .read(accountClientProvider)
        .sendCode(_server, _emailCtrl.text);
    if (mounted) setState(() => _pending = pending);
  });

  Future<void> _signIn() => _run(() async {
    final pending = _pending;
    if (pending == null) return;
    if (_codeCtrl.text.trim().isEmpty) {
      throw ApiException(0, 'no_code', 'Enter the code from the email.');
    }
    final session = await ref
        .read(accountClientProvider)
        .signIn(pending, _codeCtrl.text);
    await _finish(session);
  });

  // ---- Palm (in-app 1:N) ----
  Future<void> _palmSignIn() => _run(() async {
    _checkRelay();
    final client = ref.read(accountClientProvider);
    final config = await client.palmConfig(_server);
    if (!mounted) return;
    final result = await capturePalm(
      context,
      config.captureUri(),
      enrol: false,
    );
    if (result == null || result.code == 10002) return;
    final sessionId = result.sessionId;
    if (!result.ok || sessionId == null) {
      throw ApiException(0, 'palm_${result.code}', result.friendly);
    }
    await _finish(await client.palmSignIn(_server, sessionId));
  });

  /// Palm-only sign-up: the relay mints the account, this phone enrols the
  /// palm for it, and the relay signs the new account in.
  Future<void> _palmRegister() => _run(() async {
    _checkRelay();
    final client = ref.read(accountClientProvider);
    final config = await client.palmConfig(_server);
    final registration = await client.palmRegisterStart(_server);
    if (!mounted) return;
    final result = await capturePalm(
      context,
      config.captureUri(
        mode: 'registration',
        token: registration.token,
        userId: registration.userId,
      ),
      enrol: true,
    );
    if (result == null || result.code == 10002) return;
    final sessionId = result.sessionId;
    if (result.code == 10103 || result.code == 10104) {
      throw ApiException(
        0,
        'palm_${result.code}',
        'This palm already has a Kode account. Use "Scan palm" to sign in.',
      );
    }
    if (result.code != 0 || sessionId == null) {
      throw ApiException(0, 'palm_${result.code}', result.friendly);
    }
    await _finish(await client.palmRegisterFinish(registration, sessionId));
  });

  Future<void> _finish(AccountSession session) async {
    await ref.read(accountProvider.notifier).signIn(session);
    ref.read(accountOnboardingProvider.notifier).state = true;
    if (mounted) context.go('/devices');
  }

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    return GlassScaffold(
      appBar: GlassAppBar(title: const Text('Sign in to Kode')),
      body: SafeArea(
        child: ListView(
          padding: const EdgeInsets.all(16),
          children: [
            Text(
              'Your desktops appear automatically after signing in, and they '
              'only upload while this app is open.',
              style: TextStyle(color: colors.onSurfaceVariant),
            ),
            const SizedBox(height: 16),
            if (_error != null) ...[
              Container(
                padding: const EdgeInsets.all(12),
                decoration: BoxDecoration(
                  color: colors.errorContainer,
                  borderRadius: BorderRadius.circular(12),
                ),
                child: Text(
                  _error!,
                  style: TextStyle(color: colors.onErrorContainer),
                ),
              ),
              const SizedBox(height: 12),
            ],
            if (_methods.length > 1) ...[
              SegmentedButton<LoginMethod>(
                segments: [
                  for (final method in _methods)
                    ButtonSegment(
                      value: method,
                      icon: Icon(_methodIcon(method)),
                      label: Text(_methodLabel(method)),
                    ),
                ],
                emptySelectionAllowed: true,
                selected: _method == null ? const {} : {_method!},
                onSelectionChanged: _busy
                    ? null
                    : (selection) => setState(() {
                        _method = selection.first;
                        _error = null;
                      }),
              ),
              const SizedBox(height: 12),
            ],
            GlassSurface(
              child: Padding(
                padding: const EdgeInsets.all(16),
                child: switch (_method) {
                  LoginMethod.palm => _buildPalm(colors),
                  LoginMethod.email => _buildEmail(),
                  null =>
                    _busy
                        ? const Center(child: CircularProgressIndicator())
                        : const Text(
                            'This relay offers no sign-in method this app supports.',
                          ),
                },
              ),
            ),
            const SizedBox(height: 12),
            if (_editRelay)
              GlassSurface(
                child: Padding(
                  padding: const EdgeInsets.all(16),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.stretch,
                    children: [
                      TextField(
                        controller: _serverCtrl,
                        enabled: !_busy,
                        keyboardType: TextInputType.url,
                        autocorrect: false,
                        decoration: const InputDecoration(
                          labelText: 'Account relay URL',
                        ),
                      ),
                      const SizedBox(height: 8),
                      FilledButton.tonal(
                        onPressed: _busy ? null : _loadMethods,
                        child: const Text('Use this relay'),
                      ),
                    ],
                  ),
                ),
              )
            else
              TextButton.icon(
                onPressed: _busy
                    ? null
                    : () => setState(() => _editRelay = true),
                icon: const Icon(Icons.dns_outlined),
                label: const Text('Change account relay'),
              ),
          ],
        ),
      ),
    );
  }

  static IconData _methodIcon(LoginMethod method) => switch (method) {
    LoginMethod.palm => Icons.back_hand_outlined,
    LoginMethod.email => Icons.mail_outline,
  };

  static String _methodLabel(LoginMethod method) => switch (method) {
    LoginMethod.palm => 'Palm',
    LoginMethod.email => 'Email code',
  };

  Widget _buildPalm(ColorScheme colors) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      const Text('Hold your palm in front of the camera to sign in.'),
      const SizedBox(height: 16),
      FilledButton.icon(
        onPressed: _busy ? null : _palmSignIn,
        icon: const Icon(Icons.back_hand_outlined),
        label: const Text('Scan palm'),
      ),
      const SizedBox(height: 8),
      OutlinedButton.icon(
        onPressed: _busy ? null : _palmRegister,
        icon: const Icon(Icons.person_add_alt_1_outlined),
        label: const Text('New to Kode? Sign up with your palm'),
      ),
      const SizedBox(height: 4),
      Text(
        'Already have an email account? Sign in with the email code, then '
        'enrol your palm from the account menu.',
        style: TextStyle(color: colors.onSurfaceVariant, fontSize: 12),
      ),
    ],
  );

  Widget _buildEmail() {
    final pending = _pending;
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        TextField(
          controller: _emailCtrl,
          enabled: !_busy && pending == null,
          keyboardType: TextInputType.emailAddress,
          autocorrect: false,
          autofillHints: const [AutofillHints.email],
          decoration: const InputDecoration(labelText: 'Email'),
        ),
        if (pending != null) ...[
          const SizedBox(height: 12),
          TextField(
            controller: _codeCtrl,
            enabled: !_busy,
            autofocus: true,
            keyboardType: TextInputType.number,
            autofillHints: const [AutofillHints.oneTimeCode],
            decoration: InputDecoration(
              labelText: 'Verification code',
              helperText:
                  'Sent to ${pending.email}. Expires in ${pending.expiresIn.inMinutes} min.',
            ),
            onSubmitted: (_) => _signIn(),
          ),
        ],
        const SizedBox(height: 16),
        FilledButton(
          onPressed: _busy
              ? null
              : pending == null
              ? _sendCode
              : _signIn,
          child: _busy
              ? const SizedBox.square(
                  dimension: 18,
                  child: CircularProgressIndicator(strokeWidth: 2),
                )
              : Text(pending == null ? 'Send code' : 'Sign in'),
        ),
        if (pending != null)
          TextButton(
            onPressed: _busy
                ? null
                : () => setState(() {
                    _pending = null;
                    _codeCtrl.clear();
                  }),
            child: const Text('Use a different email'),
          ),
      ],
    );
  }
}
