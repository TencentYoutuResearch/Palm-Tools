import 'package:flutter/material.dart';

/// A draft always takes priority over remote work. An empty working composer
/// exposes a real interrupt affordance instead of a non-actionable spinner.
class SessionSendButton extends StatelessWidget {
  final bool working;
  final String text;
  final VoidCallback onSend;
  final VoidCallback onStop;
  final bool stopping;
  final bool circular;

  const SessionSendButton({
    super.key,
    required this.working,
    required this.text,
    required this.onSend,
    required this.onStop,
    this.stopping = false,
    this.circular = false,
  });

  @override
  Widget build(BuildContext context) {
    final canSend = text.trim().isNotEmpty;
    final showStop = working && !canSend;
    final label = stopping
        ? 'Stopping agent'
        : showStop
        ? 'Stop agent'
        : 'Send message';
    return Semantics(
      button: true,
      enabled: canSend || (showStop && !stopping),
      label: label,
      child: Tooltip(
        message: label,
        child: SizedBox(
          width: 40,
          height: 40,
          child: FilledButton(
            onPressed: stopping
                ? null
                : (canSend ? onSend : (showStop ? onStop : null)),
            style: FilledButton.styleFrom(
              elevation: 0,
              padding: EdgeInsets.zero,
              shape: circular
                  ? const CircleBorder()
                  : RoundedRectangleBorder(
                      borderRadius: BorderRadius.circular(13),
                    ),
            ),
            child: stopping
                ? SizedBox(
                    width: 18,
                    height: 18,
                    child: CircularProgressIndicator(
                      strokeWidth: 2,
                      color: Theme.of(context).colorScheme.primary,
                      value: MediaQuery.disableAnimationsOf(context)
                          ? 0.75
                          : null,
                    ),
                  )
                : Icon(
                    showStop ? Icons.stop_rounded : Icons.arrow_upward_rounded,
                    size: 20,
                  ),
          ),
        ),
      ),
    );
  }
}
