Agent marks are copied unchanged from `apps/gui/public/backend-icons/` in this
repository: `codex.png`, `claudecode.png`, `codebuddy.png`, and `cursor.png`.
They retain the existing Kode frontend's artwork and brand attribution. Cursor
uses the same monochrome mask treatment in the dsh frontend. Conversation
avatars are loaded from the user's Kode avatar library and are not bundled here.

`kode-wordmark-ink.png` and `kode-wordmark-red.png` split `kode-logo.png` into
two transparent layers (681×280, black background removed): the white strokes
become an alpha mask tinted with the theme's text ink, the red strokes keep the
brand red. The sidebar and blank-session hero stack them.
