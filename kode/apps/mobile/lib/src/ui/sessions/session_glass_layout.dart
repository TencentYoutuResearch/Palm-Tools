import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';

/// The transcript is the only scroller; chrome floats above it. Measured
/// insets keep the first/last item readable even with multiline drafts.
class SessionGlassLayout extends StatefulWidget {
  const SessionGlassLayout({
    super.key,
    required this.header,
    required this.composer,
    required this.transcriptBuilder,
    this.jumpToLatest,
    this.onComposerResize,
  });

  final Widget header;
  final Widget composer;
  final Widget Function(EdgeInsets padding) transcriptBuilder;
  final Widget? jumpToLatest;
  final VoidCallback? onComposerResize;

  @override
  State<SessionGlassLayout> createState() => _SessionGlassLayoutState();
}

class _SessionGlassLayoutState extends State<SessionGlassLayout> {
  double _headerHeight = 112;
  double _composerHeight = 96;

  void _measureHeader(Size size) {
    if (mounted && (_headerHeight - size.height).abs() > .5) {
      setState(() => _headerHeight = size.height);
    }
  }

  void _measureComposer(Size size) {
    if (mounted && (_composerHeight - size.height).abs() > .5) {
      widget.onComposerResize?.call();
      setState(() => _composerHeight = size.height);
    }
  }

  @override
  Widget build(BuildContext context) {
    final safe = MediaQuery.viewPaddingOf(context);
    final keyboardOpen = MediaQuery.viewInsetsOf(context).bottom > 0;
    return Stack(
      fit: StackFit.expand,
      children: [
        widget.transcriptBuilder(
          EdgeInsets.fromLTRB(16, _headerHeight + 14, 16, _composerHeight + 20),
        ),
        Positioned(
          top: 0,
          left: 0,
          right: 0,
          child: _EdgeFade(height: _headerHeight + 40, top: true),
        ),
        Positioned(
          bottom: 0,
          left: 0,
          right: 0,
          child: _EdgeFade(height: _composerHeight + 56, top: false),
        ),
        Positioned(
          top: 0,
          left: 0,
          right: 0,
          child: _MeasureSize(
            onChange: _measureHeader,
            child: Padding(
              padding: EdgeInsets.fromLTRB(12, safe.top + 8, 12, 0),
              child: widget.header,
            ),
          ),
        ),
        if (widget.jumpToLatest != null)
          Positioned(
            key: const ValueKey('session-jump-to-latest-layer'),
            bottom: _composerHeight + 8,
            left: 0,
            right: 0,
            child: Center(child: widget.jumpToLatest),
          ),
        Positioned(
          // Keep the input subtree mounted when live transcript updates add or
          // remove the preceding jump button, preserving its IME connection.
          key: const ValueKey('session-composer-layer'),
          bottom: 0,
          left: 0,
          right: 0,
          child: _MeasureSize(
            onChange: _measureComposer,
            child: Padding(
              padding: EdgeInsets.fromLTRB(
                16,
                8,
                16,
                (keyboardOpen ? 0 : safe.bottom) + 10,
              ),
              child: widget.composer,
            ),
          ),
        ),
      ],
    );
  }
}

/// A tint scrim fades continuously instead of creating a rectangular blur edge.
/// Only the interactive glass islands use backdrop filters.
class _EdgeFade extends StatelessWidget {
  const _EdgeFade({required this.height, required this.top});
  final double height;
  final bool top;

  @override
  Widget build(BuildContext context) {
    final color = Theme.of(context).scaffoldBackgroundColor;
    final solid = MediaQuery.highContrastOf(context);
    return IgnorePointer(
      child: ExcludeSemantics(
        child: SizedBox(
          height: height,
          child: DecoratedBox(
            decoration: BoxDecoration(
              gradient: LinearGradient(
                begin: top ? Alignment.topCenter : Alignment.bottomCenter,
                end: top ? Alignment.bottomCenter : Alignment.topCenter,
                stops: const [0, .4, .72, 1],
                colors: [
                  color,
                  color.withValues(alpha: solid ? 1 : .92),
                  color.withValues(alpha: .5),
                  color.withValues(alpha: 0),
                ],
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _MeasureSize extends SingleChildRenderObjectWidget {
  const _MeasureSize({required this.onChange, required super.child});
  final ValueChanged<Size> onChange;
  @override
  RenderObject createRenderObject(BuildContext context) =>
      _SizeReporter(onChange);
  @override
  void updateRenderObject(
    BuildContext context,
    covariant _SizeReporter renderObject,
  ) {
    renderObject.onChange = onChange;
  }
}

class _SizeReporter extends RenderProxyBox {
  _SizeReporter(this.onChange);
  ValueChanged<Size> onChange;
  Size? _previous;
  @override
  void performLayout() {
    super.performLayout();
    if (size == _previous) return;
    _previous = size;
    final measured = size;
    WidgetsBinding.instance.addPostFrameCallback((_) => onChange(measured));
  }
}
