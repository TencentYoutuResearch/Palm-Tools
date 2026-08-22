import 'package:flutter/material.dart';

const _backendAssetDirectory = '../gui/public/backend-icons';

@immutable
class BackendIdentity {
  final String label;
  final String fallback;
  final String? asset;
  final Color accent;

  const BackendIdentity({
    required this.label,
    required this.fallback,
    required this.asset,
    required this.accent,
  });

  String? get assetPath =>
      asset == null ? null : '$_backendAssetDirectory/$asset.png';
}

const _backendProfiles = <String, BackendIdentity>{
  'codebuddy': BackendIdentity(
    label: 'CodeBuddy',
    fallback: 'CB',
    asset: 'codebuddy',
    accent: Color(0xFF6878E8),
  ),
  'claude': BackendIdentity(
    label: 'Claude',
    fallback: 'CL',
    asset: 'claudecode',
    accent: Color(0xFFD97757),
  ),
  'claude-code': BackendIdentity(
    label: 'Claude',
    fallback: 'CL',
    asset: 'claudecode',
    accent: Color(0xFFD97757),
  ),
  'claudecode': BackendIdentity(
    label: 'Claude',
    fallback: 'CL',
    asset: 'claudecode',
    accent: Color(0xFFD97757),
  ),
  'codex': BackendIdentity(
    label: 'Codex',
    fallback: 'CX',
    asset: 'codex',
    accent: Color(0xFF7A9DFF),
  ),
  'gemini': BackendIdentity(
    label: 'Gemini',
    fallback: 'GE',
    asset: 'gemini',
    accent: Color(0xFF3186FF),
  ),
  'opencode': BackendIdentity(
    label: 'OpenCode',
    fallback: 'OC',
    asset: 'opencode',
    accent: Color(0xFF8C918D),
  ),
  'amp': BackendIdentity(
    label: 'Amp',
    fallback: 'AM',
    asset: 'amp',
    accent: Color(0xFFE8B168),
  ),
  'cursor': BackendIdentity(
    label: 'Cursor',
    fallback: 'CU',
    asset: 'cursor',
    accent: Color(0xFFF54E00),
  ),
  'cursor-agent': BackendIdentity(
    label: 'Cursor',
    fallback: 'CU',
    asset: 'cursor',
    accent: Color(0xFFF54E00),
  ),
  'copilot': BackendIdentity(
    label: 'Copilot',
    fallback: 'CP',
    asset: 'githubcopilot',
    accent: Color(0xFF6E40C9),
  ),
  'github-copilot': BackendIdentity(
    label: 'Copilot',
    fallback: 'CP',
    asset: 'githubcopilot',
    accent: Color(0xFF6E40C9),
  ),
  'grok': BackendIdentity(
    label: 'Grok',
    fallback: 'GR',
    asset: 'grok',
    accent: Color(0xFF737873),
  ),
  'antigravity': BackendIdentity(
    label: 'Antigravity',
    fallback: 'AG',
    asset: 'antigravity',
    accent: Color(0xFF4285F4),
  ),
  'kimi': BackendIdentity(
    label: 'Kimi',
    fallback: 'KI',
    asset: 'kimi',
    accent: Color(0xFF777080),
  ),
  'pi': BackendIdentity(
    label: 'Pi',
    fallback: 'PI',
    asset: 'pi',
    accent: Color(0xFF777C78),
  ),
  'kiro': BackendIdentity(
    label: 'Kiro',
    fallback: 'KI',
    asset: 'kiro',
    accent: Color(0xFF9046FF),
  ),
  'droid': BackendIdentity(
    label: 'Droid',
    fallback: 'DR',
    asset: 'droid',
    accent: Color(0xFF737873),
  ),
};

BackendIdentity backendIdentity(String backendKey) {
  final raw = backendKey.trim();
  final base = raw
      .replaceAll('\\', '/')
      .split('/')
      .last
      .toLowerCase()
      .replaceFirst(RegExp(r'\.(cmd|exe|sh|zsh|bash)$'), '')
      .replaceAll(RegExp(r'[_\s]+'), '-');
  final candidates = <String>{
    base,
    base.replaceFirst(RegExp(r'-internal$'), ''),
    base.replaceFirst(RegExp(r'-cli$'), ''),
  };
  for (final candidate in candidates) {
    final profile = _backendProfiles[candidate];
    if (profile != null) return profile;
  }

  final parts = base.split('-').where((part) => part.isNotEmpty).toList();
  final fallback = parts.length >= 2
      ? '${parts.first[0]}${parts[1][0]}'.toUpperCase()
      : (parts.isEmpty
            ? '?'
            : parts.first
                  .substring(0, parts.first.length.clamp(1, 2))
                  .toUpperCase());
  return BackendIdentity(
    label: raw.isEmpty ? 'Agent' : raw,
    fallback: fallback,
    asset: null,
    accent: const Color(0xFF7A9DFF),
  );
}

String sessionStatusLabel(String status) => switch (status) {
  'busy' => 'WORKING',
  'idle' => 'READY',
  'starting' => 'STARTING',
  'exited' => 'EXITED',
  _ => status.toUpperCase(),
};

class BackendAvatar extends StatelessWidget {
  final String backendKey;
  final double size;

  const BackendAvatar({super.key, required this.backendKey, this.size = 32});

  @override
  Widget build(BuildContext context) {
    final identity = backendIdentity(backendKey);
    final colors = Theme.of(context).colorScheme;
    final fallback = Center(
      child: Text(
        identity.fallback,
        style: TextStyle(
          color: identity.accent,
          fontSize: size * 0.29,
          fontWeight: FontWeight.w900,
          letterSpacing: -0.2,
        ),
      ),
    );

    return Semantics(
      label: '${identity.label} agent',
      image: true,
      child: Container(
        width: size,
        height: size,
        padding: EdgeInsets.all(size * 0.19),
        decoration: BoxDecoration(
          color: Color.alphaBlend(
            identity.accent.withValues(alpha: 0.10),
            colors.surface,
          ),
          borderRadius: BorderRadius.circular(size * 0.31),
          border: Border.all(color: identity.accent.withValues(alpha: 0.34)),
        ),
        child: identity.assetPath == null
            ? fallback
            : Image.asset(
                identity.assetPath!,
                fit: BoxFit.contain,
                errorBuilder: (_, _, _) => fallback,
              ),
      ),
    );
  }
}

class BackendStatusAvatar extends StatelessWidget {
  final String backendKey;
  final String statusLabel;
  final Color statusColor;
  final double size;

  const BackendStatusAvatar({
    super.key,
    required this.backendKey,
    required this.statusLabel,
    required this.statusColor,
    this.size = 40,
  });

  @override
  Widget build(BuildContext context) {
    final identity = backendIdentity(backendKey);
    final colors = Theme.of(context).colorScheme;
    return Semantics(
      label: '${identity.label} agent, $statusLabel',
      image: true,
      child: ExcludeSemantics(
        child: SizedBox(
          width: size,
          height: size,
          child: Stack(
            clipBehavior: Clip.none,
            children: [
              BackendAvatar(backendKey: backendKey, size: size),
              Positioned(
                right: -1,
                bottom: -1,
                child: Container(
                  width: size * 0.28,
                  height: size * 0.28,
                  decoration: BoxDecoration(
                    color: statusColor,
                    shape: BoxShape.circle,
                    border: Border.all(color: colors.surface, width: 2),
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
