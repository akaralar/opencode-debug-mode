import { tool, type Plugin } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import { AGENT_PROMPT } from "./prompt"
import {
  CANNED_FIXED,
  CANNED_PROCEED,
  DEBUG_AGENT,
  DEBUG_TOOL_NAMES,
  appendNdjsonLine,
  clearDebugLog,
  debugLogPath,
  ensureParent,
  formatLogEntry,
  isInsideDebugLogDir,
  parseNdjson,
  readDebugLog,
  readIngestState,
  shortSessionID,
  writeIngestState,
  type DebugSession,
  type IngestState,
} from "./shared"

// ── Ingest server ───────────────────────────────────────────────────────────

const DEBUG_COMMAND_TEMPLATE =
  "The user wants to debug the following issue using runtime evidence. Follow the DEBUG MODE workflow: form hypotheses, instrument, present reproduction steps with the `question` tool, analyze the logs, and fix only with log proof."

type BunServeOptions = {
  hostname: string
  port: number
  fetch: (request: Request) => Response | Promise<Response>
}
type BunServer = { port: number; stop: (force?: boolean) => void }
type BunLike = { serve: (options: BunServeOptions) => BunServer }

function getBun(): BunLike | undefined {
  return (globalThis as unknown as { Bun?: BunLike }).Bun
}

type IngestServer = {
  port: number
  ingestPathId: string
  stop: () => void
}

function normalizeNdjson(body: string): string {
  const trimmed = body.replace(/[\r\n\s]+$/, "")
  return trimmed ? `${trimmed}\n` : ""
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "POST, OPTIONS",
    "access-control-allow-headers": "content-type, x-debug-session-id",
  }
}

function startIngestServer(directory: string): IngestServer | undefined {
  const bun = getBun()
  if (!bun) return undefined

  const persisted = readIngestState()
  const ingestPathId = persisted?.ingestPathId ?? crypto.randomUUID()
  const bind = process.env.OPENCODE_DEBUG_BIND?.trim() || "127.0.0.1"

  const handler = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)

    if (request.method === "OPTIONS" && url.pathname === `/ingest/${ingestPathId}`) {
      return new Response(null, { status: 204, headers: corsHeaders() })
    }
    if (request.method !== "POST" || url.pathname !== `/ingest/${ingestPathId}`) {
      return new Response("not found", { status: 404 })
    }

    const rawSession = request.headers.get("x-debug-session-id") ?? ""
    if (!rawSession) return new Response("missing-session-id", { status: 400 })
    const sessionID = rawSession.replace(/[^a-zA-Z0-9_-]/g, "")
    if (!sessionID) return new Response("invalid-session-id", { status: 400 })

    const body = normalizeNdjson(await request.text())
    if (body) {
      const logPath = debugLogPath(directory, sessionID)
      ensureParent(logPath)
      appendFileSync(logPath, body, "utf8")
    }
    return new Response(null, { status: 204, headers: corsHeaders() })
  }

  let server: BunServer | undefined
  try {
    server = bun.serve({ hostname: bind, port: persisted?.port ?? 0, fetch: handler })
  } catch {
    try {
      server = bun.serve({ hostname: bind, port: 0, fetch: handler })
    } catch {
      return undefined
    }
  }

  const state: IngestState = { port: server.port, ingestPathId }
  writeIngestState(state)

  return {
    port: server.port,
    ingestPathId,
    stop: () => server?.stop(true),
  }
}

// ── Debug reminder ──────────────────────────────────────────────────────────

function renderDebugReminder(session: DebugSession, bindHost: string): string {
  const endpointHost = bindHost === "0.0.0.0" ? "<this machine's LAN IP>" : "127.0.0.1"
  return `<system-reminder>
# Debug Mode - Runtime Evidence

You are in DEBUG MODE. Debug with runtime evidence, not code guessing.

## Session configuration

- Log file (NDJSON): \`${session.logPath}\`
- Ingest endpoint: \`http://${endpointHost}:${session.port}/ingest/${session.ingestPathId}\`
- Required header for the endpoint: \`X-Debug-Session-Id: ${session.shortID}\`
- Session id: \`${session.shortID}\`

The Simulator shares the host filesystem and loopback, so app code may append to the log file directly and/or POST to the endpoint. A physical device cannot use the file path — POST to the endpoint using this machine's LAN IP instead.

## Tools

- \`debug_log\` — append one NDJSON entry (agent-side evidence).
- \`debug_clear\` — truncate the session log before a run (does NOT remove instrumentation from code).
- \`debug_read\` — read parsed entries for hypothesis analysis.

## NDJSON entry shape

\`\`\`json
{"hypothesisId":"A","location":"file.swift:42","message":"score before clamp","data":{"score":85},"timestamp":1733456789000,"runId":"pre-fix"}
\`\`\`

Instrument existing files in place — add every log (and any helper) to a file already in the build. Do NOT create a new source file for instrumentation: builds that enumerate their sources (XcodeGen/Tuist, manifests, Makefiles) will not compile it, so the logs silently never appear.

## Reproduction contract

Hand off to the user with the \`question\` tool — never end your turn with prose steps, and do not attempt autonomous reproduction first.

- Before a run: put the numbered reproduction steps in the question and offer "${CANNED_PROCEED}".
- After a fix: ask the user to verify and offer "${CANNED_FIXED}".

Before each run: \`debug_clear\`. Keep instrumentation during fixes and tag verification entries \`runId: "post-fix"\`. Remove instrumentation only after log-proven success or explicit confirmation.
</system-reminder>`
}

// ── Plugin ──────────────────────────────────────────────────────────────────

const DebugModePlugin: Plugin = async (ctx) => {
  const agentPrompt = AGENT_PROMPT
  const activeDebugSessions = new Set<string>()
  const knownNonDebugSessions = new Set<string>()
  let ingest: IngestServer | undefined

  function ensureIngest(): IngestServer | undefined {
    if (!ingest) ingest = startIngestServer(ctx.directory)
    return ingest
  }

  function getDebugSession(sessionID: string): DebugSession | undefined {
    const server = ensureIngest()
    if (!server) return undefined
    return {
      sessionID,
      shortID: shortSessionID(sessionID),
      logPath: debugLogPath(ctx.directory, sessionID),
      endpoint: `http://127.0.0.1:${server.port}/ingest/${server.ingestPathId}`,
      port: server.port,
      ingestPathId: server.ingestPathId,
    }
  }

  async function isDebugSession(sessionID: string | undefined): Promise<boolean> {
    if (!sessionID) return false
    if (activeDebugSessions.has(sessionID)) return true
    if (knownNonDebugSessions.has(sessionID)) return false
    try {
      const response = await ctx.client.session.messages({
        path: { id: sessionID },
        query: { directory: ctx.directory },
      })
      const messages = response.data ?? []
      for (let i = messages.length - 1; i >= 0; i--) {
        const info = messages[i]?.info
        if (info?.role === "user" && typeof info.agent === "string") {
          if (info.agent === DEBUG_AGENT) {
            activeDebugSessions.add(sessionID)
            return true
          }
          knownNonDebugSessions.add(sessionID)
          return false
        }
      }
    } catch {
      // Message lookup is best-effort; treat as non-debug.
    }
    return false
  }

  function denyDebugTools(agent: Record<string, any>): void {
    const permission = typeof agent.permission === "object" && agent.permission !== null ? agent.permission : {}
    for (const name of DEBUG_TOOL_NAMES) permission[name] = "deny"
    agent.permission = permission
  }

  return {
    config: async (config) => {
      const mutable = config as Record<string, any>
      mutable.agent ??= {}

      const existing = mutable.agent[DEBUG_AGENT] ?? {}
      mutable.agent[DEBUG_AGENT] = {
        ...existing,
        mode: "primary",
        description:
          "Systematic debugging with runtime evidence: hypotheses, instrumentation, reproduction, log analysis, verified fix.",
        color: "error",
        prompt: agentPrompt,
        permission: {
          ...(typeof existing.permission === "object" && existing.permission !== null ? existing.permission : {}),
          debug_log: "allow",
          debug_clear: "allow",
          debug_read: "allow",
          question: "allow",
        },
      }

      for (const [name, agent] of Object.entries(mutable.agent)) {
        if (name === DEBUG_AGENT || !agent || typeof agent !== "object") continue
        denyDebugTools(agent as Record<string, any>)
      }
      for (const name of ["build", "plan", "general", "explore"]) {
        if (name === DEBUG_AGENT) continue
        const agent = (mutable.agent[name] ??= {})
        denyDebugTools(agent)
      }

      // Register the /debug command so the package is self-contained.
      mutable.command ??= {}
      if (!mutable.command[DEBUG_AGENT]) {
        mutable.command[DEBUG_AGENT] = {
          template: `${DEBUG_COMMAND_TEMPLATE}\n\n$ARGUMENTS`,
          description:
            "Debug an issue with runtime evidence (hypothesis → instrument → reproduce → analyze → fix → verify)",
          agent: DEBUG_AGENT,
        }
      }

      mutable.experimental ??= {}
      const primaryTools: string[] = Array.isArray(mutable.experimental.primary_tools)
        ? mutable.experimental.primary_tools
        : []
      for (const name of DEBUG_TOOL_NAMES) {
        if (!primaryTools.includes(name)) primaryTools.push(name)
      }
      mutable.experimental.primary_tools = primaryTools
    },

    tool: {
      debug_log: tool({
        description:
          "Append one NDJSON entry to the debug session log (runtime evidence). Use for agent-side evidence; app-side code should write to the log file or POST to the ingest endpoint.",
        args: {
          message: tool.schema.string().describe("Human-readable description of what is being logged"),
          data: tool.schema
            .record(tool.schema.string(), tool.schema.unknown())
            .optional()
            .describe("Structured values relevant to the hypothesis"),
          hypothesisId: tool.schema.string().optional().describe("Hypothesis this entry tests (e.g. 'A')"),
          location: tool.schema.string().optional().describe("Code location, e.g. 'File.swift:42'"),
          runId: tool.schema.string().optional().describe("Run tag, e.g. 'pre-fix' or 'post-fix'"),
        },
        async execute(args, context) {
          const logPath = debugLogPath(context.directory, context.sessionID)
          appendNdjsonLine(logPath, {
            hypothesisId: args.hypothesisId,
            location: args.location,
            message: args.message,
            data: args.data ?? {},
            runId: args.runId,
            sessionId: shortSessionID(context.sessionID),
            timestamp: Date.now(),
          })
          return `Logged to ${logPath}`
        },
      }),

      debug_clear: tool({
        description:
          "Truncate the debug session log before a reproduction run. This clears captured evidence only; it does NOT remove instrumentation from code.",
        args: {},
        async execute(_args, context) {
          const logPath = debugLogPath(context.directory, context.sessionID)
          clearDebugLog(logPath)
          return `Cleared ${logPath}`
        },
      }),

      debug_read: tool({
        description: "Read the debug session log as parsed NDJSON entries for hypothesis analysis.",
        args: {
          tail: tool.schema.number().optional().describe("Return only the last N entries"),
        },
        async execute(args, context) {
          const logPath = debugLogPath(context.directory, context.sessionID)
          const entries = parseNdjson(readDebugLog(logPath))
          const selected = args.tail && args.tail > 0 ? entries.slice(-args.tail) : entries
          if (selected.length === 0) {
            return `No log entries at ${logPath}. The log may not exist yet, or the reproduction did not reach the instrumentation.`
          }
          const lines = selected.map((entry) => formatLogEntry(entry))
          return `${selected.length} entr${selected.length === 1 ? "y" : "ies"} from ${logPath}:\n${lines.join("\n")}`
        },
      }),
    },

    "chat.message": async (input) => {
      if (!input.sessionID) return
      if (input.agent === DEBUG_AGENT) {
        activeDebugSessions.add(input.sessionID)
        knownNonDebugSessions.delete(input.sessionID)
      } else if (input.agent) {
        knownNonDebugSessions.add(input.sessionID)
        activeDebugSessions.delete(input.sessionID)
      }
    },

    "experimental.chat.system.transform": async (input, output) => {
      if (!(await isDebugSession(input.sessionID))) return
      const session = getDebugSession(input.sessionID as string)
      if (!session) return
      const bind = process.env.OPENCODE_DEBUG_BIND?.trim() || "127.0.0.1"
      output.system.push(renderDebugReminder(session, bind))
    },

    "permission.ask": async (input, output) => {
      const patterns = input.pattern === undefined ? [] : Array.isArray(input.pattern) ? input.pattern : [input.pattern]
      if (patterns.length === 0) return
      if (patterns.every((pattern) => isInsideDebugLogDir(ctx.directory, pattern))) {
        output.status = "allow"
      }
    },

    event: async ({ event }) => {
      if (event.type === "session.deleted") {
        const sessionID = (event.properties as { info?: { id?: string } }).info?.id
        if (sessionID) {
          activeDebugSessions.delete(sessionID)
          knownNonDebugSessions.delete(sessionID)
        }
      }
    },

    dispose: async () => {
      ingest?.stop()
      ingest = undefined
    },
  }
}

export default DebugModePlugin
