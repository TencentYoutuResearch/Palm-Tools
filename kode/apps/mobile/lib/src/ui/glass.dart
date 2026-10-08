/// Shared iOS-inspired materials. Blur is clipped and reserved for fixed chrome;
/// scrolling cards use the same translucent material without a backdrop filter.
library;

import 'dart:ui';
import 'package:flutter/material.dart';

class GlassSurface extends StatelessWidget {
  const GlassSurface({
    super.key,
    required this.child,
    this.radius = 22,
    this.blur = false,
    this.padding = EdgeInsets.zero,
    this.floating = false,
    this.subtle = false,
    this.prominent = false,
  });

  final Widget child;
  final double radius;
  final bool blur;
  final EdgeInsetsGeometry padding;
  final bool floating;
  final bool subtle;

  /// A stronger floating surface for the conversation composer.
  final bool prominent;

  @override
  Widget build(BuildContext context) {
    final colors = Theme.of(context).colorScheme;
    final dark = colors.brightness == Brightness.dark;
    final solid =
        MediaQuery.highContrastOf(context) ||
        MediaQuery.disableAnimationsOf(context);
    final content = DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        gradient: LinearGradient(
          begin: Alignment.topLeft,
          end: Alignment.bottomRight,
          colors: solid
              ? [colors.surface, colors.surface]
              : [
                  colors.surface.withValues(
                    alpha: subtle
                        ? .38
                        : (prominent
                              ? (dark ? .88 : .94)
                              : (floating ? .72 : (dark ? .88 : .82))),
                  ),
                  colors.surface.withValues(
                    alpha: subtle
                        ? .24
                        : (prominent
                              ? (dark ? .72 : .84)
                              : (floating ? .48 : (dark ? .68 : .58))),
                  ),
                ],
        ),
        border: Border.all(
          color: solid
              ? colors.outline
              : Colors.white.withValues(
                  alpha: subtle
                      ? (dark ? .08 : .38)
                      : (floating ? (dark ? .10 : .50) : (dark ? .10 : .38)),
                ),
          width: .7,
        ),
      ),
      child: Material(
        type: MaterialType.transparency,
        child: Padding(padding: padding, child: child),
      ),
    );
    // The shadow must sit outside the blur clip or it gets cut off entirely.
    return DecoratedBox(
      decoration: BoxDecoration(
        borderRadius: BorderRadius.circular(radius),
        boxShadow: floating && !subtle && !solid
            ? [
                BoxShadow(
                  color: Colors.black.withValues(
                    alpha: prominent ? (dark ? .38 : .20) : (dark ? .20 : .10),
                  ),
                  blurRadius: prominent ? 32 : 20,
                  offset: Offset(0, prominent ? 8 : 5),
                ),
              ]
            : null,
      ),
      child: ClipRRect(
        borderRadius: BorderRadius.circular(radius),
        // Keep the same child hierarchy when accessibility settings change so
        // focused fields retain their state and platform input connection.
        child: BackdropFilter(
          enabled: blur && !solid,
          filter: ImageFilter.blur(sigmaX: 18, sigmaY: 18),
          child: content,
        ),
      ),
    );
  }
}

/// Owns one static backdrop per route; keyboard/safe-area behavior stays with Scaffold.
class GlassScaffold extends StatelessWidget {
  const GlassScaffold({
    super.key,
    required this.body,
    this.appBar,
    this.resizeToAvoidBottomInset,
  });
  final Widget body;
  final PreferredSizeWidget? appBar;
  final bool? resizeToAvoidBottomInset;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final colors = theme.colorScheme;
    final highContrast = MediaQuery.highContrastOf(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        color: theme.scaffoldBackgroundColor,
        gradient: highContrast
            ? null
            : LinearGradient(
                begin: Alignment.topLeft,
                end: Alignment.bottomRight,
                stops: const [0, .48, 1],
                colors: [
                  Color.alphaBlend(
                    colors.primary.withValues(alpha: .12),
                    theme.scaffoldBackgroundColor,
                  ),
                  theme.scaffoldBackgroundColor,
                  Color.alphaBlend(
                    colors.tertiary.withValues(alpha: .13),
                    theme.scaffoldBackgroundColor,
                  ),
                ],
              ),
      ),
      child: Scaffold(
        backgroundColor: Colors.transparent,
        resizeToAvoidBottomInset: resizeToAvoidBottomInset,
        appBar: appBar,
        body: body,
      ),
    );
  }
}

class GlassNavigationBackground extends StatelessWidget {
  const GlassNavigationBackground({super.key});
  @override
  Widget build(BuildContext context) => const GlassSurface(
    radius: 0,
    blur: true,
    subtle: true,
    child: SizedBox.expand(),
  );
}

/// Quiet shared navigation: unboxed title and a single action capsule.
class GlassAppBar extends StatelessWidget implements PreferredSizeWidget {
  const GlassAppBar({super.key, required this.title, this.actions = const []});
  final Widget title;
  final List<Widget> actions;
  @override
  Size get preferredSize => const Size.fromHeight(64);
  @override
  Widget build(BuildContext context) {
    final canPop = ModalRoute.of(context)?.canPop ?? false;
    return AppBar(
      toolbarHeight: 64,
      backgroundColor: Colors.transparent,
      surfaceTintColor: Colors.transparent,
      elevation: 0,
      scrolledUnderElevation: 0,
      automaticallyImplyLeading: false,
      leadingWidth: canPop ? 60 : null,
      leading: canPop
          ? Padding(
              padding: const EdgeInsets.fromLTRB(12, 10, 4, 10),
              child: GlassSurface(
                radius: 28,
                blur: true,
                floating: true,
                subtle: true,
                child: IconButton(
                  tooltip: MaterialLocalizations.of(context).backButtonTooltip,
                  onPressed: () => Navigator.of(context).maybePop(),
                  icon: const Icon(Icons.arrow_back_ios_new_rounded, size: 20),
                ),
              ),
            )
          : null,
      titleSpacing: canPop ? 4 : 16,
      title: title,
      titleTextStyle: Theme.of(context).textTheme.titleLarge?.copyWith(
        color: Theme.of(context).colorScheme.onSurface,
        fontSize: 20,
        fontWeight: FontWeight.w700,
        letterSpacing: -.4,
      ),
      actions: actions.isEmpty
          ? null
          : [
              Padding(
                padding: const EdgeInsets.fromLTRB(8, 10, 12, 10),
                child: GlassSurface(
                  radius: 28,
                  blur: true,
                  floating: true,
                  subtle: true,
                  child: Row(mainAxisSize: MainAxisSize.min, children: actions),
                ),
              ),
            ],
    );
  }
}
