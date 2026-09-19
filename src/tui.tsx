import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { createSignal, For, Show } from "solid-js"
import {
  DEBUG_AGENT,
  clearDebugLog,
  debugLogPath,
  formatLogEntry,
  parseNdjson,
  type DebugLogEntry,
} from "./shared"

const POLL_INTERVAL_MS = 500
const MAX_ENTRIES = 8

function currentSessionID(api: TuiPluginApi): string | undefined {
  const current = api.route.current
  if (current.name === "session") {
    const params = current.params as { sessionID?: string } | undefined
    if (params?.sessionID) return params.sessionID
  }
  return undefined
}

function isDebugSession(api: TuiPluginApi, sessionID: string | undefined): boolean {
  if (!sessionID) return false
  try {
    const session = api.state.session.get(sessionID)
    if (session?.agent === DEBUG_AGENT) return true
    if (session?.agent) return false
    const messages = api.state.session.messages(sessionID)
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i]
      if (message.role === "user" && typeof message.agent === "string") {
        return message.agent === DEBUG_AGENT
      }
    }
  } catch {
    return false
  }
  return false
}

// ── Log panel state (module scope: the host recreates slot components) ─────

const [logEntries, setLogEntries] = createSignal<DebugLogEntry[]>([])
const [logSessionID, setLogSessionID] = createSignal<string | undefined>()

let logOffset = 0
let logPending = ""

function resetLog(): void {
  logOffset = 0
  logPending = ""
  setLogEntries([])
}

function startLogPolling(api: TuiPluginApi): () => void {
  function refresh(): void {
    const candidate = currentSessionID(api)
    const active = isDebugSession(api, candidate) ? candidate : undefined
    if (active !== logSessionID()) {
      setLogSessionID(active)
      resetLog()
    }
    if (!active) return

    const file = debugLogPath(api.state.path.directory, active)
    let chunk = ""
    try {
      const stat = statSync(file)
      if (stat.size < logOffset) resetLog()
      if (stat.size === logOffset) return
      const size = stat.size - logOffset
      const buffer = Buffer.alloc(size)
      const fd = openSync(file, "r")
      try {
        readSync(fd, buffer, 0, size, logOffset)
      } finally {
        closeSync(fd)
      }
      logOffset = stat.size
      chunk = logPending + buffer.toString("utf8")
    } catch {
      return
    }
    const lastNewline = chunk.lastIndexOf("\n")
    if (lastNewline === -1) {
      logPending = chunk
      return
    }
    logPending = chunk.slice(lastNewline + 1)
    const parsed = parseNdjson(chunk.slice(0, lastNewline))
    if (parsed.length === 0) return
    setLogEntries((previous) => [...previous, ...parsed].slice(-MAX_ENTRIES))
  }

  const timer = setInterval(refresh, POLL_INTERVAL_MS)
  refresh()
  return () => clearInterval(timer)
}

function DebugLogPanel(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current
  return (
    <Show when={logSessionID()}>
      {(id) => (
        <box flexDirection="column" flexShrink={0}>
          <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
            <text fg={theme().error}>
              <b>Debug Logs</b>
            </text>
            <text fg={theme().textMuted}>{`${logEntries().length} shown`}</text>
            <box flexGrow={1} />
            <text
              fg={theme().textMuted}
              onMouseDown={() => {
                clearDebugLog(debugLogPath(props.api.state.path.directory, id()))
                resetLog()
              }}
            >
              clear
            </text>
          </box>
          <Show
            when={logEntries().length > 0}
            fallback={
              <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
                Waiting for log entries…
              </text>
            }
          >
            <For each={logEntries()}>
              {(entry) => (
                <text fg={theme().textMuted} wrapMode="word" paddingLeft={1}>
                  {formatLogEntry(entry)}
                </text>
              )}
            </For>
          </Show>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const stopLogPolling = startLogPolling(api)
  api.lifecycle.onDispose(() => {
    stopLogPolling()
  })

  api.slots.register({
    order: 40,
    slots: {
      app_bottom() {
        return <DebugLogPanel api={api} />
      },
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "debug.clearLog",
        title: "Debug: clear session log",
        category: "Debug",
        namespace: "palette",
        slashName: "debug-clear",
        run: () => {
          const sessionID = currentSessionID(api)
          if (!sessionID) return
          const file = debugLogPath(api.state.path.directory, sessionID)
          clearDebugLog(file)
          resetLog()
          api.ui.toast({ variant: "info", title: "Debug Mode", message: `Cleared ${file}` })
        },
      },
    ],
  })
}

const DebugModeTui = {
  id: "debug-mode-tui",
  tui,
}

export default DebugModeTui
