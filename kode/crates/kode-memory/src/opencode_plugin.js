// kode opencode plugin — managed by kode, rewritten on every kode launch.
// Edits here are overwritten; delete the file to opt out until kode restarts.
//
// Inside a kode tab the PTY env carries KODE_HOOK_SOCK (HookRelay socket) and
// KODE_SESSION_ID (tab id). Each user prompt reports the opencode session in use,
// so kode binds the tab to the exact session instead of guessing by cwd + time.
// Outside kode both variables are absent and the plugin does nothing.
import { createConnection } from "node:net"

const sock = process.env.KODE_HOOK_SOCK
const tab = process.env.KODE_SESSION_ID

function send(event, sessionID) {
  try {
    const conn = createConnection(sock)
    conn.on("error", () => {})
    conn.end(
      JSON.stringify({
        hook_event_name: event,
        session_id: tab,
        opencode_session_uuid: sessionID,
      }) + "\n",
    )
  } catch {}
}

export const KodeBridge = async () => {
  if (!sock || !tab) return {}
  // Subagent sessions also emit prompts and idles; only the root session is the tab's.
  const children = new Set()
  return {
    "chat.message": async ({ sessionID }) => {
      if (!children.has(sessionID)) send("UserPromptSubmit", sessionID)
    },
    event: async ({ event }) => {
      const info = event.properties?.info
      if (info?.parentID) children.add(info.id)
      if (event.type === "session.idle") {
        const sessionID = event.properties?.sessionID
        if (sessionID && !children.has(sessionID)) send("Stop", sessionID)
      }
    },
  }
}
