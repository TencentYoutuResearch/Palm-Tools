/// Kode Flutter theme — aligned with apps/gui/index.html design tokens.
///
/// 设计语言:
///   - green-tinted neutral surfaces + soft green accent
///   - low-contrast borders and compact information density
///   - status colors are semantic; they do not replace the primary accent
///
/// 使用:
///   - `KillLaColors.*` 常量:用于状态色 / 装饰色
///   - `KillLaTheme.dark()` / `KillLaTheme.light()`:套到 MaterialApp.theme
///   - 业务代码不要再写 Colors.indigo / Colors.amber 之类硬编码 —
///     有 status / attention / mode 语义的位置都该走 KillLaColors
library;

import 'package:flutter/material.dart';

/// 颜色常量 —— 与 GUI/colors.html 完全一致(单源同步)
///
/// 在写新组件时:
///   - 主操作色 → [accent] / [accentHover]
///   - 警示 / 危险 → [danger] / [dangerStrong]
///   - busy 进行中 → [busy](火焰橙)
///   - "需要注意" 黄(idle / awaiting answer)→ [warning]
///   - 文本三档:[textPrimary] / [textSecondary] / [textMuted]
class KillLaColors {
  KillLaColors._();

  // ---- Dark (主皮)----
  static const bgPrimary = Color(0xFF0D0F0E);
  static const bgSecondary = Color(0xFF111413);
  static const bgTertiary = Color(0xFF181B19);

  /// Kode desktop accent.
  static const accent = Color(0xFF9FE870);
  static const accentHover = Color(0xFFB3F28B);

  /// 深红 —— 错误 / 危险
  static const danger = Color(0xFFE06C75);
  static const dangerStrong = Color(0xFFC95B65);

  /// 警示黄 —— Senketsu fiber 色,idle / 注意提示
  static const warning = Color(0xFFE8B86D);

  /// 火焰橙 —— busy / running
  static const busy = Color(0xFF7FB4E8);

  static const textPrimary = Color(0xFFEDEFEB);
  static const textSecondary = Color(0xFFA8AEA7);
  static const textMuted = Color(0xFF70776F);

  static const border = Color(0xFF262B28);
  static const borderStrong = Color(0xFF3A413C);

  // ---- Light (副皮,降低纯度,用户切系统主题时用)----
  static const lightBg = Color(0xFFF7F7F3);
  static const lightSurface = Color(0xFFECEDE8);
  static const lightElevated = Color(0xFFFFFFFF);
  static const lightAccent = Color(0xFF216E45);
  static const lightAccentHover = Color(0xFF2B8054);
  static const lightDanger = Color(0xFFB54750);
  static const lightWarning = Color(0xFF9A6B20);
  static const lightBusy = Color(0xFF3977A8);
  static const lightTextPrimary = Color(0xFF171A18);
  static const lightTextSecondary = Color(0xFF4F5750);
  static const lightTextMuted = Color(0xFF7A827B);
  static const lightBorder = Color(0xFFD9DDD5);

  /// session 状态点配色(starting/idle/busy/exited)
  static Color statusDot(String status) => switch (status) {
    'busy' => busy,
    'idle' => warning,
    'starting' => textMuted,
    'exited' => textMuted,
    _ => textMuted,
  };

  /// permission mode chip 配色
  static Color modeColor(String? m) => switch (m) {
    'default' => textSecondary,
    'acceptEdits' => accent,
    'plan' => warning, // 黄 — 计划态
    'bypassPermissions' => dangerStrong, // 深红警告
    _ => textMuted,
  };

  /// task 状态配色(completed / in_progress / deleted / pending)
  static (Color, IconData, String) taskStyle(String status) => switch (status) {
    'completed' => (warning, Icons.check_circle, 'completed'),
    'in_progress' => (accent, Icons.play_circle_fill, 'in progress'),
    'deleted' => (textMuted, Icons.cancel, 'deleted'),
    _ => (busy, Icons.radio_button_unchecked, 'pending'),
  };

  /// tool_use 状态点
  static Color toolStatus(String s) => switch (s) {
    'ok' => warning,
    'error' => danger,
    _ => busy,
  };

  /// attention 配色(ask=主红,plan=警示黄)
  static Color attention(String kind) => kind == 'plan' ? warning : accent;
}

/// 整体 ThemeData
class KillLaTheme {
  KillLaTheme._();

  static ThemeData dark() {
    const onAccent = Color(0xFF07100B);

    final scheme = ColorScheme(
      brightness: Brightness.dark,
      primary: KillLaColors.accent,
      onPrimary: onAccent,
      secondary: KillLaColors.warning,
      onSecondary: Colors.black,
      error: KillLaColors.danger,
      onError: onAccent,
      surface: KillLaColors.bgSecondary,
      onSurface: KillLaColors.textPrimary,
      surfaceContainerHighest: KillLaColors.bgTertiary,
      surfaceContainer: KillLaColors.bgSecondary,
      outline: KillLaColors.border,
      outlineVariant: KillLaColors.borderStrong,
    );

    return _buildBase(
      scheme: scheme,
      bg: KillLaColors.bgPrimary,
      surfaceLow: KillLaColors.bgSecondary,
      surfaceHi: KillLaColors.bgTertiary,
      textPrimary: KillLaColors.textPrimary,
      textSecondary: KillLaColors.textSecondary,
      textMuted: KillLaColors.textMuted,
      border: KillLaColors.border,
      accent: KillLaColors.accent,
    );
  }

  static ThemeData light() {
    const onAccent = Colors.white;

    final scheme = ColorScheme(
      brightness: Brightness.light,
      primary: KillLaColors.lightAccent,
      onPrimary: onAccent,
      secondary: KillLaColors.lightWarning,
      onSecondary: Colors.black,
      error: KillLaColors.lightDanger,
      onError: onAccent,
      surface: KillLaColors.lightElevated,
      onSurface: KillLaColors.lightTextPrimary,
      surfaceContainerHighest: KillLaColors.lightSurface,
      surfaceContainer: KillLaColors.lightSurface,
      outline: KillLaColors.lightBorder,
      outlineVariant: KillLaColors.lightBorder,
    );

    return _buildBase(
      scheme: scheme,
      bg: KillLaColors.lightBg,
      surfaceLow: KillLaColors.lightSurface,
      surfaceHi: KillLaColors.lightElevated,
      textPrimary: KillLaColors.lightTextPrimary,
      textSecondary: KillLaColors.lightTextSecondary,
      textMuted: KillLaColors.lightTextMuted,
      border: KillLaColors.lightBorder,
      accent: KillLaColors.lightAccent,
    );
  }

  static ThemeData _buildBase({
    required ColorScheme scheme,
    required Color bg,
    required Color surfaceLow,
    required Color surfaceHi,
    required Color textPrimary,
    required Color textSecondary,
    required Color textMuted,
    required Color border,
    required Color accent,
  }) {
    // System font stack mirrors the desktop GUI.
    const headingFamily = '.SF Pro Display';
    const bodyFamily = '.SF Pro Text';

    final textTheme = TextTheme(
      // 极少用,但保留
      displayLarge: TextStyle(
        color: textPrimary,
        fontFamily: headingFamily,
        fontWeight: FontWeight.w700,
        letterSpacing: -0.5,
      ),
      titleLarge: TextStyle(
        color: textPrimary,
        fontWeight: FontWeight.w700,
        fontFamily: headingFamily,
        letterSpacing: 0.2,
      ),
      titleMedium: TextStyle(
        color: textPrimary,
        fontWeight: FontWeight.w700,
        fontFamily: headingFamily,
      ),
      titleSmall: TextStyle(
        color: textPrimary,
        fontWeight: FontWeight.w700,
        fontFamily: bodyFamily,
      ),
      bodyLarge: TextStyle(color: textPrimary, fontFamily: bodyFamily),
      bodyMedium: TextStyle(color: textPrimary, fontFamily: bodyFamily),
      bodySmall: TextStyle(color: textSecondary, fontFamily: bodyFamily),
      labelLarge: TextStyle(
        color: textPrimary,
        fontFamily: bodyFamily,
        fontWeight: FontWeight.w700,
      ),
      labelSmall: TextStyle(color: textMuted, fontFamily: bodyFamily),
    );

    const radSm = 8.0;
    const radMd = 10.0;
    const radLg = 14.0;

    return ThemeData(
      useMaterial3: true,
      colorScheme: scheme,
      brightness: scheme.brightness,
      scaffoldBackgroundColor: bg,
      canvasColor: bg,
      dividerColor: border,
      hintColor: textMuted,
      textTheme: textTheme,

      appBarTheme: AppBarTheme(
        backgroundColor: surfaceLow,
        foregroundColor: textPrimary,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: false,
        shape: Border(bottom: BorderSide(color: border, width: 1)),
        titleTextStyle: TextStyle(
          color: textPrimary,
          fontWeight: FontWeight.w700,
          fontSize: 16,
          letterSpacing: 0.4,
          fontFamily: headingFamily,
        ),
        iconTheme: IconThemeData(color: textPrimary),
        actionsIconTheme: IconThemeData(color: textPrimary),
      ),

      cardTheme: CardThemeData(
        color: surfaceLow,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radMd),
          side: BorderSide(color: border, width: 1),
        ),
        margin: EdgeInsets.zero,
      ),

      filledButtonTheme: FilledButtonThemeData(
        style: FilledButton.styleFrom(
          backgroundColor: accent,
          foregroundColor: scheme.onPrimary,
          disabledBackgroundColor: surfaceHi,
          disabledForegroundColor: textMuted,
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radSm),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 18, vertical: 12),
          textStyle: const TextStyle(
            fontWeight: FontWeight.w800,
            letterSpacing: 0.6,
          ),
        ),
      ),

      outlinedButtonTheme: OutlinedButtonThemeData(
        style: OutlinedButton.styleFrom(
          foregroundColor: accent,
          side: BorderSide(color: accent, width: 1.5),
          shape: RoundedRectangleBorder(
            borderRadius: BorderRadius.circular(radSm),
          ),
          padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 11),
          textStyle: const TextStyle(
            fontWeight: FontWeight.w700,
            letterSpacing: 0.4,
          ),
        ),
      ),

      iconButtonTheme: IconButtonThemeData(
        style: IconButton.styleFrom(foregroundColor: textPrimary),
      ),

      inputDecorationTheme: InputDecorationTheme(
        filled: true,
        fillColor: surfaceLow,
        hintStyle: TextStyle(color: textMuted),
        labelStyle: TextStyle(color: textSecondary),
        contentPadding: const EdgeInsets.symmetric(
          horizontal: 12,
          vertical: 12,
        ),
        border: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radSm),
          borderSide: BorderSide(color: border),
        ),
        enabledBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radSm),
          borderSide: BorderSide(color: border),
        ),
        focusedBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radSm),
          borderSide: BorderSide(color: accent, width: 2),
        ),
        errorBorder: OutlineInputBorder(
          borderRadius: BorderRadius.circular(radSm),
          borderSide: BorderSide(color: scheme.error, width: 1.5),
        ),
      ),

      dividerTheme: DividerThemeData(color: border, thickness: 1, space: 1),

      listTileTheme: ListTileThemeData(
        iconColor: textSecondary,
        textColor: textPrimary,
        tileColor: surfaceLow,
        selectedTileColor: accent.withValues(alpha: 0.18),
        contentPadding: const EdgeInsets.symmetric(horizontal: 14, vertical: 6),
      ),

      snackBarTheme: SnackBarThemeData(
        backgroundColor: surfaceHi,
        contentTextStyle: TextStyle(color: textPrimary),
        actionTextColor: accent,
        behavior: SnackBarBehavior.floating,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radMd),
          side: BorderSide(color: accent, width: 1),
        ),
      ),

      progressIndicatorTheme: ProgressIndicatorThemeData(
        color: accent,
        circularTrackColor: surfaceHi,
      ),

      popupMenuTheme: PopupMenuThemeData(
        color: surfaceHi,
        elevation: 4,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radSm),
          side: BorderSide(color: border),
        ),
        textStyle: TextStyle(color: textPrimary),
      ),

      dialogTheme: DialogThemeData(
        backgroundColor: surfaceLow,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(radLg),
          side: BorderSide(color: accent, width: 1.5),
        ),
        titleTextStyle: TextStyle(
          color: textPrimary,
          fontWeight: FontWeight.w800,
          fontSize: 18,
        ),
      ),

      radioTheme: RadioThemeData(
        fillColor: WidgetStateProperty.resolveWith((states) {
          if (states.contains(WidgetState.selected)) return accent;
          return textMuted;
        }),
      ),

      visualDensity: VisualDensity.adaptivePlatformDensity,
    );
  }
}
