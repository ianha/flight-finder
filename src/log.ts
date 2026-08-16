type Level = 'debug' | 'info' | 'warn' | 'error'

let verbose = false

export function setVerbose(v: boolean): void {
  verbose = v
}

function emit(level: Level, msg: string, extra?: unknown): void {
  if (level === 'debug' && !verbose) return
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`
  const stream = level === 'error' || level === 'warn' ? console.error : console.log
  if (extra !== undefined) stream(line, extra)
  else stream(line)
}

export const log = {
  debug: (msg: string, extra?: unknown) => emit('debug', msg, extra),
  info: (msg: string, extra?: unknown) => emit('info', msg, extra),
  warn: (msg: string, extra?: unknown) => emit('warn', msg, extra),
  error: (msg: string, extra?: unknown) => emit('error', msg, extra),
}
