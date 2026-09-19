import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import { closeSync, openSync, readSync, statSync } from "node:fs"
import { createSignal, For, Show } from "solid-js"
import {
  CANNED_FIXED,
  CANNED_PROCEED,
  DEBUG_AGENT,
  clearDebugLog,
  clearReproRequest,
  debugLogPath,
  formatLogEntry,
  parseNdjson,
  readReproRequest,
  type DebugLogEntry,
  type ReproRequest,
} from "./shared"

const POLL_INTERVAL_MS = 500
const MAX_ENTRIES = 8
const MAX_STEPS = 8

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

async function submitToDebug(api: TuiPluginApi, sessionID: string, text: string): Promise<void> {
  try {
    await api.client.session.abort({ sessionID })
  } catch {
    // Nothing in flight is fine.
  }
  try {
    await api.client.session.prompt({
      sessionID,
      agent: DEBUG_AGENT,
      parts: [{ type: "text", text }],
    })
  } catch (error) {
    api.ui.toast({
      variant: "error",
      title: "Debug Mode",
      message: `Could not send message: ${error instanceof Error ? error.message : String(error)}`,
    })
  }
}

// ── Module-scope state (the host recreates slot components on each render) ──

const [logEntries, setLogEntries] = createSignal<DebugLogEntry[]>([])
const [logSessionID, setLogSessionID] = createSignal<string | undefined>()
const [reproRequest, setReproRequest] = createSignal<ReproRequest | undefined>()
const [reproSessionID, setReproSessionID] = createSignal<string | undefined>()

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

function startReproPolling(api: TuiPluginApi): () => void {
  function refresh(): void {
    const sessionID = currentSessionID(api)
    const request = sessionID ? readReproRequest(api.state.path.directory, sessionID) : undefined

    if (!sessionID || !request) {
      setReproRequest(undefined)
      setReproSessionID(undefined)
      return
    }

    // A direct user reply already answers the request; stop showing the panel.
    try {
      const messages = api.state.session.messages(sessionID)
      for (let i = messages.length - 1; i >= 0; i--) {
        const message = messages[i]
        if (message.role !== "user") continue
        if (message.time.created > request.createdAt) {
          clearReproRequest(api.state.path.directory, sessionID)
          setReproRequest(undefined)
          setReproSessionID(undefined)
          return
        }
        break
      }
    } catch {
      // State not ready yet; show the panel.
    }

    setReproSessionID(sessionID)
    setReproRequest(request)
  }

  const timer = setInterval(refresh, POLL_INTERVAL_MS)
  refresh()
  return () => clearInterval(timer)
}

// ── Components ──────────────────────────────────────────────────────────────

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

function ReproductionPanel(props: { api: TuiPluginApi }) {
  const theme = () => props.api.theme.current

  function dismiss(): void {
    const sessionID = reproSessionID()
    if (sessionID) clearReproRequest(props.api.state.path.directory, sessionID)
    setReproRequest(undefined)
    setReproSessionID(undefined)
  }

  function settle(choice: "proceed" | "fixed", text?: string): void {
    const sessionID = reproSessionID()
    if (!sessionID) return
    dismiss()
    const message = choice === "proceed" ? (text ? `${CANNED_PROCEED}. ${text}` : CANNED_PROCEED) : CANNED_FIXED
    void submitToDebug(props.api, sessionID, message)
  }

  function followUp(): void {
    const sessionID = reproSessionID()
    if (!sessionID) return
    props.api.ui.dialog.replace(() =>
      props.api.ui.DialogPrompt({
        title: "Debug follow-up",
        placeholder: "Describe what happened…",
        onConfirm: (value) => {
          props.api.ui.dialog.clear()
          dismiss()
          const text = value.trim()
          if (text) void submitToDebug(props.api, sessionID, text)
        },
        onCancel: () => props.api.ui.dialog.clear(),
      }),
    )
  }

  return (
    <Show when={reproRequest()}>
      {(request) => (
        <box flexDirection="column" flexShrink={0}>
          <box flexDirection="row" gap={2} paddingLeft={1} paddingRight={1}>
            <text fg={theme().warning}>
              <b>Reproduction steps</b>
            </text>
            <text fg={theme().textMuted}>or type a reply below</text>
            <box flexGrow={1} />
            <text fg={theme().textMuted} onMouseDown={dismiss}>
              dismiss
            </text>
          </box>
          <For each={request().steps.slice(0, MAX_STEPS)}>
            {(step, index) => (
              <text fg={theme().text} wrapMode="word" paddingLeft={1}>
                {`${index() + 1}. ${step}`}
              </text>
            )}
          </For>
          <box flexDirection="row" gap={3} paddingLeft={1} paddingTop={0}>
            <box onMouseDown={() => settle("proceed")}>
              <text fg={theme().error}>
                <b>Proceed</b>
              </text>
            </box>
            <box onMouseDown={() => settle("fixed")}>
              <text fg={theme().success}>Mark fixed</text>
            </box>
            <box onMouseDown={followUp}>
              <text fg={theme().textMuted}>Follow-up</text>
            </box>
          </box>
        </box>
      )}
    </Show>
  )
}

const tui: TuiPlugin = async (api) => {
  const stopLogPolling = startLogPolling(api)
  const stopReproPolling = startReproPolling(api)
  api.lifecycle.onDispose(() => {
    stopLogPolling()
    stopReproPolling()
  })

  api.slots.register({
    order: 40,
    slots: {
      app_bottom() {
        return (
          <box flexDirection="column" flexShrink={0}>
            <ReproductionPanel api={api} />
            <DebugLogPanel api={api} />
          </box>
        )
      },
    },
  })

  api.keymap.registerLayer({
    commands: [
      {
        name: "debug.proceed",
        title: "Debug: issue reproduced",
        category: "Debug",
        namespace: "palette",
        slashName: "debug-proceed",
        run: () => {
          const sessionID = currentSessionID(api)
          if (!sessionID) return
          clearReproRequest(api.state.path.directory, sessionID)
          setReproRequest(undefined)
          void submitToDebug(api, sessionID, CANNED_PROCEED)
        },
      },
      {
        name: "debug.markFixed",
        title: "Debug: mark fixed and clean up",
        category: "Debug",
        namespace: "palette",
        slashName: "debug-fixed",
        run: () => {
          const sessionID = currentSessionID(api)
          if (!sessionID) return
          clearReproRequest(api.state.path.directory, sessionID)
          setReproRequest(undefined)
          void submitToDebug(api, sessionID, CANNED_FIXED)
        },
      },
      {
        name: "debug.followUp",
        title: "Debug: write a follow-up",
        category: "Debug",
        namespace: "palette",
        slashName: "debug-follow-up",
        run: () => {
          const sessionID = currentSessionID(api)
          if (!sessionID) return
          api.ui.dialog.replace(() =>
            api.ui.DialogPrompt({
              title: "Debug follow-up",
              placeholder: "Describe what happened…",
              onConfirm: (value) => {
                api.ui.dialog.clear()
                clearReproRequest(api.state.path.directory, sessionID)
                setReproRequest(undefined)
                const text = value.trim()
                if (text) void submitToDebug(api, sessionID, text)
              },
              onCancel: () => api.ui.dialog.clear(),
            }),
          )
        },
      },
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
