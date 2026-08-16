import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { parse, parseDocument, Document } from 'yaml'
import { z } from 'zod'
import { configSchema, type AppConfig } from './shared/configSchema.js'
import { HARD_MAX_WINDOW_DAYS } from './shared/constants.js'
import { log } from './log.js'

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly issues: { path: string; message: string }[] = [],
  ) {
    super(message)
    this.name = 'ConfigError'
  }
}

export function parseConfig(raw: unknown): AppConfig {
  const result = configSchema.safeParse(raw ?? {})
  if (!result.success) {
    const issues = result.error.issues.map((i) => ({
      path: i.path.join('.'),
      message: i.message,
    }))
    throw new ConfigError(
      `Invalid configuration: ${issues.map((i) => `${i.path}: ${i.message}`).join('; ')}`,
      issues,
    )
  }
  return result.data
}

/** Load config from a YAML file; an absent file yields all defaults. */
export function loadConfig(path: string): AppConfig {
  if (!existsSync(path)) {
    log.info(`No config file at ${path} — using defaults`)
    return parseConfig({})
  }
  let raw: unknown
  try {
    raw = parse(readFileSync(path, 'utf8'))
  } catch (err) {
    throw new ConfigError(`Could not parse ${path}: ${(err as Error).message}`)
  }
  return parseConfig(raw)
}

function fmtLocalDate(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

function addDays(d: Date, days: number): Date {
  const out = new Date(d)
  out.setDate(out.getDate() + days)
  return out
}

/** Derive the concrete search window (local calendar dates) from relative offsets. */
export function deriveWindow(
  cfg: AppConfig,
  today: Date = new Date(),
): { startDate: string; endDate: string } {
  const startOffset = Math.min(cfg.search.window.startOffsetDays, HARD_MAX_WINDOW_DAYS)
  const endOffset = Math.min(cfg.search.window.endOffsetDays, HARD_MAX_WINDOW_DAYS)
  return {
    startDate: fmtLocalDate(addDays(today, startOffset)),
    endDate: fmtLocalDate(addDays(today, Math.max(endOffset, startOffset))),
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function setDeep(doc: Document, prefix: (string | number)[], value: unknown): void {
  if (isPlainObject(value)) {
    for (const [k, v] of Object.entries(value)) setDeep(doc, [...prefix, k], v)
    return
  }
  // Replacing a sequence node drops comments attached to its items, so leave
  // arrays untouched when the value hasn't actually changed.
  if (Array.isArray(value)) {
    const existing = doc.getIn(prefix, true)
    const existingJson =
      existing && typeof (existing as { toJSON?: () => unknown }).toJSON === 'function'
        ? (existing as { toJSON: () => unknown }).toJSON()
        : undefined
    if (JSON.stringify(existingJson) === JSON.stringify(value)) return
  }
  // Scalars and changed arrays are set wholesale; setting the value of an
  // existing key keeps the key's attached comments.
  doc.setIn(prefix, value)
}

/**
 * Persist a validated config to YAML, preserving hand-written comments: the
 * existing file is parsed as a Document and only leaf values are set, then the
 * result is written atomically (tmp + rename).
 */
export function writeConfig(path: string, cfg: AppConfig): void {
  let doc: Document
  if (existsSync(path)) {
    doc = parseDocument(readFileSync(path, 'utf8'))
    if (doc.errors.length > 0) doc = new Document({})
  } else {
    doc = new Document({})
  }
  setDeep(doc, [], cfg)
  const tmp = `${path}.tmp`
  writeFileSync(tmp, doc.toString())
  renameSync(tmp, path)
}

/** Minimal .env loader (KEY=VALUE lines); existing env vars win. Avoids a dotenv dep. */
export function loadDotEnv(path = '.env'): void {
  if (!existsSync(path)) return
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq <= 0) continue
    const key = trimmed.slice(0, eq).trim()
    let value = trimmed.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined) process.env[key] = value
  }
}

export interface EnvSecrets {
  seatsAeroApiKey: string | undefined
  smtpPassword: string | undefined
}

export function readEnvSecrets(env: NodeJS.ProcessEnv = process.env): EnvSecrets {
  return {
    seatsAeroApiKey: env.SEATS_AERO_API_KEY || undefined,
    smtpPassword: env.SMTP_PASSWORD || undefined,
  }
}

export { configSchema, type AppConfig, z }
