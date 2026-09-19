import { appendFileSync, existsSync, mkdirSync, readFileSync, truncateSync, unlinkSync, writeFileSync } from "node:fs"
import os from "node:os"
import path from "node:path"

export const DEBUG_AGENT = "debug"

export const DEBUG_TOOL_NAMES = [
  "debug_log",
  "debug_clear",
  "debug_read",
  "debug_repro_steps",
] as const

export const DEBUG_LOG_DIRNAME = path.join(".opencode", "debug-log")

export const DEBUG_STATE_DIR = path.join(os.homedir(), ".local", "share", "opencode", "debug")
export const DEBUG_STATE_FILE = path.join(DEBUG_STATE_DIR, "state.json")

export const CANNED_PROCEED = "Issue reproduced, please proceed"
export const CANNED_FIXED = "The issue has been fixed. Please clean up the instrumentation."

export type IngestState = {
  port: number
  ingestPathId: string
}

export type DebugSession = {
  sessionID: string
  shortID: string
  logPath: string
  endpoint: string
  port: number
  ingestPathId: string
}

export type DebugLogEntry = {
  timestamp?: number
  message?: string
  location?: string
  hypothesisId?: string
  runId?: string
  data?: unknown
  raw?: string
}

// ── Reproduction request handshake (filesystem, process-safe) ──────────────

export type ReproChoice = "proceed" | "fixed" | "followup" | "dismissed"

export type ReproRequest = {
  id: string
  sessionID: string
  steps: string[]
  createdAt: number
}

export function reproRequestPath(directory: string, sessionID: string): string {
  return path.join(debugLogDir(directory), `repro-${shortSessionID(sessionID)}.json`)
}

export function writeReproRequest(directory: string, sessionID: string, steps: string[]): ReproRequest {
  const request: ReproRequest = {
    id: crypto.randomUUID(),
    sessionID,
    steps,
    createdAt: Date.now(),
  }
  const file = reproRequestPath(directory, sessionID)
  ensureParent(file)
  writeFileSync(file, JSON.stringify(request), "utf8")
  return request
}

export function readReproRequest(directory: string, sessionID: string): ReproRequest | undefined {
  try {
    const parsed = JSON.parse(readFileSync(reproRequestPath(directory, sessionID), "utf8")) as Partial<ReproRequest>
    if (typeof parsed.id === "string" && Array.isArray(parsed.steps)) {
      return {
        id: parsed.id,
        sessionID: typeof parsed.sessionID === "string" ? parsed.sessionID : sessionID,
        steps: parsed.steps.map((step) => String(step)),
        createdAt: typeof parsed.createdAt === "number" ? parsed.createdAt : 0,
      }
    }
  } catch {
    // No pending request is the common case.
  }
  return undefined
}

export function clearReproRequest(directory: string, sessionID: string): void {
  try {
    unlinkSync(reproRequestPath(directory, sessionID))
  } catch {
    // Already gone.
  }
}

// ── Paths & log IO ─────────────────────────────────────────────────────────

export function shortSessionID(sessionID: string): string {
  const cleaned = sessionID.replace(/[^a-zA-Z0-9]/g, "").toLowerCase()
  return cleaned.slice(0, 6) || "000000"
}

export function debugLogDir(directory: string): string {
  const override = process.env.OPENCODE_DEBUG_LOG_DIR?.trim()
  return override && override.length > 0 ? override : path.join(directory, DEBUG_LOG_DIRNAME)
}

export function debugLogPath(directory: string, sessionID: string): string {
  return path.join(debugLogDir(directory), `session-${shortSessionID(sessionID)}.log`)
}

export function ensureParent(filePath: string): void {
  mkdirSync(path.dirname(filePath), { recursive: true })
}

export function isInsideDebugLogDir(directory: string, candidate: string): boolean {
  const root = path.resolve(debugLogDir(directory))
  const target = path.resolve(candidate)
  return target === root || target.startsWith(`${root}${path.sep}`)
}

export function readIngestState(): IngestState | undefined {
  try {
    const parsed = JSON.parse(readFileSync(DEBUG_STATE_FILE, "utf8")) as Partial<IngestState>
    if (typeof parsed.port === "number" && typeof parsed.ingestPathId === "string") {
      return { port: parsed.port, ingestPathId: parsed.ingestPathId }
    }
  } catch {
    // Missing or malformed state is expected on first run.
  }
  return undefined
}

export function writeIngestState(state: IngestState): void {
  mkdirSync(DEBUG_STATE_DIR, { recursive: true })
  writeFileSync(DEBUG_STATE_FILE, JSON.stringify(state), "utf8")
}

export function appendNdjsonLine(logPath: string, entry: Record<string, unknown>): void {
  ensureParent(logPath)
  appendFileSync(logPath, `${JSON.stringify(entry)}\n`, "utf8")
}

export function clearDebugLog(logPath: string): void {
  ensureParent(logPath)
  if (existsSync(logPath)) truncateSync(logPath, 0)
  else writeFileSync(logPath, "", "utf8")
}

export function readDebugLog(logPath: string): string {
  try {
    return readFileSync(logPath, "utf8")
  } catch {
    return ""
  }
}

export function parseNdjson(text: string): DebugLogEntry[] {
  const entries: DebugLogEntry[] = []
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    entries.push(parseLine(trimmed))
  }
  return entries
}

export function parseLine(line: string): DebugLogEntry {
  try {
    const parsed = JSON.parse(line) as Record<string, unknown>
    return {
      timestamp: typeof parsed.timestamp === "number" ? parsed.timestamp : undefined,
      message: typeof parsed.message === "string" ? parsed.message : undefined,
      location: typeof parsed.location === "string" ? parsed.location : undefined,
      hypothesisId: typeof parsed.hypothesisId === "string" ? parsed.hypothesisId : undefined,
      runId: typeof parsed.runId === "string" ? parsed.runId : undefined,
      data: parsed.data,
    }
  } catch {
    return { raw: line }
  }
}

export function formatLogEntry(entry: DebugLogEntry): string {
  const time = typeof entry.timestamp === "number" ? new Date(entry.timestamp).toLocaleTimeString() : "--:--:--"
  const message = entry.message ?? entry.raw ?? "(unparsed)"
  const hypothesis = entry.hypothesisId ? ` [${entry.hypothesisId}]` : ""
  const run = entry.runId ? ` (${entry.runId})` : ""
  return `${time} ${message}${hypothesis}${run}`
}
