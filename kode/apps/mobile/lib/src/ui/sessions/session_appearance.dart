import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../../api/api_client.dart';
import '../../protocol/protocol.dart';
import '../../state/providers.dart';
import '../../storage/session_images.dart';
import '../theme.dart';
import 'backend_identity.dart';

/// Shared banner presets mirroring desktop DSH & Kode GUI `BOT_BANNER_PRESETS`.
const Map<String, List<Color>> _bannerPresets = {
  'blurple': [Color(0xFF4F46E5), Color(0xFF7C3AED), Color(0xFF312E81)],
  'aurora': [Color(0xFF10B981), Color(0xFF14B8A6), Color(0xFF38BDF8)],
  'cyber': [Color(0xFFEC4899), Color(0xFF8B5CF6), Color(0xFF22D3EE)],
  'sunset': [Color(0xFFF97316), Color(0xFFF43F5E), Color(0xFFA855F7)],
  'forest': [Color(0xFF065F46), Color(0xFF10B981), Color(0xFF047857)],
  'sakura': [Color(0xFFF472B6), Color(0xFFFB7185), Color(0xFFC084FC)],
  'ocean': [Color(0xFF2563EB), Color(0xFF0EA5E9), Color(0xFF06B6D4)],
  'amber': [Color(0xFFF59E0B), Color(0xFFEA580C), Color(0xFFD97706)],
  // Legacy preset aliases kept for backward compatibility
  'ember': [Color(0xFFC2410C), Color(0xFFE11D48), Color(0xFF7C2D12)],
  'slate': [Color(0xFF1E293B), Color(0xFF475569), Color(0xFF0F172A)],
  'plum': [Color(0xFF6D28D9), Color(0xFFDB2777), Color(0xFF4C1D95)],
  'mint': [Color(0xFF0F766E), Color(0xFF22C55E), Color(0xFF115E59)],
  'rose': [Color(0xFFBE185D), Color(0xFFF43F5E), Color(0xFF881337)],
};

/// Parses a bot `banner` specification (`preset:<id>` or `color:#rrggbb`)
/// into a Flutter [LinearGradient], or `null` when `none` / unset.
LinearGradient? resolveBannerGradient(String? banner) {
  final raw = banner?.trim() ?? '';
  if (raw.isEmpty || raw == 'none' || raw == 'auto') return null;
  if (raw.startsWith('preset:')) {
    final colors = _bannerPresets[raw.substring(7)];
    if (colors != null) {
      return LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: colors,
      );
    }
  }
  if (raw.startsWith('color:')) {
    final hex = raw.substring(6).trim();
    if (RegExp(r'^#[0-9a-fA-F]{6}$').hasMatch(hex)) {
      final value = int.parse(hex.substring(1), radix: 16);
      final base = Color(0xFF000000 | value);
      return LinearGradient(
        begin: Alignment.topLeft,
        end: Alignment.bottomRight,
        colors: [base, base.withValues(alpha: 0.78)],
      );
    }
  }
  return null;
}

/// In-memory file cache so avatars & backgrounds render synchronously across
/// list scrolls and route transitions once fetched from [SessionImageStore].
final Map<String, File> _resolvedImageCache = {};

class _SyncedImage extends ConsumerStatefulWidget {
  final SessionImageRef imageRef;
  final BoxFit fit;
  final Widget Function(BuildContext context) fallback;

  const _SyncedImage({
    required this.imageRef,
    this.fit = BoxFit.cover,
    required this.fallback,
  });

  @override
  ConsumerState<_SyncedImage> createState() => _SyncedImageState();
}

class _SyncedImageState extends ConsumerState<_SyncedImage> {
  File? _file;
  bool _failed = false;

  @override
  void initState() {
    super.initState();
    _load();
  }

  @override
  void didUpdateWidget(covariant _SyncedImage oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.imageRef.id != widget.imageRef.id) {
      _failed = false;
      _load();
    }
  }

  void _load() {
    final cached = _resolvedImageCache[widget.imageRef.id];
    if (cached != null && cached.existsSync()) {
      _file = cached;
      return;
    }
    _file = null;
    final ApiClient? api = ref.read(apiClientProvider);
    if (api == null) return;
    final refId = widget.imageRef.id;
    SessionImageStore.instance.fetch(widget.imageRef, api).then(
      (file) {
        _resolvedImageCache[refId] = file;
        if (!mounted || widget.imageRef.id != refId) return;
        setState(() {
          _file = file;
          _failed = false;
        });
      },
      onError: (_) {
        if (!mounted || widget.imageRef.id != refId) return;
        setState(() => _failed = true);
      },
    );
  }

  @override
  Widget build(BuildContext context) {
    ref.listen<ApiClient?>(apiClientProvider, (prev, next) {
      if (next != null && next != prev && (_file == null || _failed)) {
        _failed = false;
        _load();
      }
    });
    final file = _file;
    if (file == null || _failed) return widget.fallback(context);
    return Image.file(
      file,
      fit: widget.fit,
      gaplessPlayback: true,
      errorBuilder: (_, _, _) => widget.fallback(context),
    );
  }
}

/// Renders a session or bot avatar synced from desktop (`avatarImage`),
/// gracefully falling back to [BackendStatusAvatar] when unset or loading.
class SessionStatusAvatar extends StatelessWidget {
  final SessionDto? session;
  final String backendKey;
  final bool working;
  final double size;

  const SessionStatusAvatar({
    super.key,
    this.session,
    required this.backendKey,
    required this.working,
    this.size = 38,
  });

  @override
  Widget build(BuildContext context) {
    final avatarRef = session?.avatarImage;
    if (avatarRef == null) {
      return BackendStatusAvatar(
        backendKey: backendKey,
        working: working,
        size: size,
      );
    }

    final colors = Theme.of(context).colorScheme;
    final badgeSize = (size * 0.30).clamp(9.0, 12.0);
    final radius = BorderRadius.circular(size * 0.32);

    return SizedBox(
      width: size,
      height: size,
      child: Stack(
        clipBehavior: Clip.none,
        children: [
          Positioned.fill(
            child: ClipRRect(
              borderRadius: radius,
              child: _SyncedImage(
                imageRef: avatarRef,
                fit: BoxFit.cover,
                fallback: (_) => BackendAvatar(
                  backendKey: backendKey,
                  size: size,
                ),
              ),
            ),
          ),
          Positioned(
            right: -1.5,
            bottom: -1.5,
            child: Container(
              width: badgeSize,
              height: badgeSize,
              decoration: BoxDecoration(
                shape: BoxShape.circle,
                color: working ? KillLaColors.busy : KillLaColors.accent,
                border: Border.all(
                  color: colors.surface,
                  width: 1.8,
                ),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

/// Atmospheric background layer for [SessionDetailScreen] or bot cards,
/// rendering synced desktop `backgroundImage` / `bannerImage` or `banner`
/// gradient with an adaptive legibility scrim.
class SessionBackgroundLayer extends StatelessWidget {
  final SessionDto? session;
  final bool compact;

  const SessionBackgroundLayer({
    super.key,
    required this.session,
    this.compact = false,
  });

  @override
  Widget build(BuildContext context) {
    final s = session;
    if (s == null) return const SizedBox.shrink();
    final imageRef = compact
        ? (s.bannerImage ?? s.backgroundImage)
        : (s.backgroundImage ?? s.bannerImage);
    final gradient = resolveBannerGradient(s.banner);
    if (imageRef == null && gradient == null) return const SizedBox.shrink();

    final theme = Theme.of(context);
    final dark = theme.brightness == Brightness.dark;
    final highContrast = MediaQuery.highContrastOf(context);
    if (highContrast) return const SizedBox.shrink();

    final base = theme.scaffoldBackgroundColor;

    return IgnorePointer(
      child: Stack(
        fit: StackFit.expand,
        children: [
          if (imageRef != null)
            Opacity(
              opacity: compact ? (dark ? 0.38 : 0.28) : (dark ? 0.24 : 0.16),
              child: _SyncedImage(
                imageRef: imageRef,
                fit: BoxFit.cover,
                fallback: (_) => gradient != null
                    ? DecoratedBox(decoration: BoxDecoration(gradient: gradient))
                    : const SizedBox.shrink(),
              ),
            )
          else if (gradient != null)
            Opacity(
              opacity: compact ? (dark ? 0.34 : 0.22) : (dark ? 0.20 : 0.12),
              child: DecoratedBox(decoration: BoxDecoration(gradient: gradient)),
            ),
          DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: compact ? Alignment.centerLeft : Alignment.topCenter,
                end: compact ? Alignment.centerRight : Alignment.bottomCenter,
                colors: compact
                    ? [
                        base.withValues(alpha: dark ? 0.72 : 0.78),
                        base.withValues(alpha: dark ? 0.42 : 0.56),
                        base.withValues(alpha: dark ? 0.24 : 0.38),
                      ]
                    : [
                        base.withValues(alpha: dark ? 0.72 : 0.78),
                        base.withValues(alpha: dark ? 0.86 : 0.88),
                      ],
              ),
            ),
          ),
        ],
      ),
    );
  }
}
