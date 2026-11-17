# kode.new-ui — dsh view for Kode desktop

Kode extension (`kode-extension.json`, schema `kode.extension/v1`) that shows
Kode sessions in the DeepSeek Harness conversation UI and switches them
between Kode's terminal and dsh.

It wraps the `@kode/dsh` integration in this directory's parent; nothing is
forked. `npm run build:kode-extension` (from `integrations/dsh`) packs that
integration into `vendor/kode-dsh.tgz` and writes the finished extension to
`dist/kode-extension/`. `./run.sh app` does this and bundles the result into
the app, which installs it on first start.

At runtime `bin/start.mjs` installs the pinned dsh CLI and the vendored
integration into the extension's data directory, then serves `dsh web` and
reports its URL to Kode (see `apps/gui/src-tauri/src/extensions/`).
