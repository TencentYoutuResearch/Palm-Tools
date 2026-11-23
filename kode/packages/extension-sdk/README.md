# @kode/extension-sdk

Client for the Kode extension API (`kode.api/v1`, served by the Kode backend
at `/api/ext/v1`). Kode passes `KODE_EXT_API` and `KODE_EXT_TOKEN` to an
extension backend whose manifest requests API capabilities.

```js
import { KodeExtension } from '@kode/extension-sdk'
const kode = new KodeExtension()
const { event_cursor } = await kode.hello()
const { session } = await kode.createSession({ backendKey: 'claude', cwd, initialInput: 'hi', labels: ['team:call'] })
for await (const event of kode.events({ after: event_cursor, kinds: ['session.turn_completed'] })) {
  if (event.session_id === session.id) console.log(event.payload.final_message?.text)
}
```

| Capability | Allows |
|---|---|
| `sessions.create` | start sessions (owned by this extension) |
| `sessions.input` / `sessions.interrupt` | write to / stop owned sessions |
| `sessions.read` | list and read sessions it does not own; `owner: 'any'` |
| `events.subscribe` | the event stream |
| `bots.read` | list bots and start sessions as one (`createSession({ bot: 'default', ... })`) |

Events: `session.created`, `session.input_result`, `session.turn_started`,
`session.turn_completed` (with `final_message`), `session.awaiting`,
`session.awaiting_cleared`, `session.exited`. `events()` resumes from the last
cursor after a disconnect.
