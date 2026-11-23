# Extension API sample

The smallest consumer of `kode.api/v1` (see `docs/arch/extension-platform.md`).

- `kode-extension.json` asks only for API capabilities, so Kode starts the
  backend with a scoped `KODE_EXT_TOKEN` and `KODE_EXT_API` — never the admin
  token.
- `bin/start.mjs` follows the pushed events of the sessions it owns and logs
  them (Settings → Extensions → logs). Its page is read-only.
- `bin/demo.mjs` is a development check against a running Kode: it mints the
  sample's grant with the local admin connection, starts a session with an
  initial prompt and waits for `session.turn_completed`.

```sh
node bin/demo.mjs claude /path/to/project "Reply with the word ok"
```

Install it from Settings → Extensions (link mode keeps it in place).
