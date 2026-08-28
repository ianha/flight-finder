// Dev runner: starts the backend (tsx watch, serve) and the Vite dev server
// together, prefixes their output, and tears both down on exit. No deps.
import { spawn } from 'node:child_process'

const procs = []

function run(name, color, cmd, args) {
  const child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: process.env })
  procs.push(child)
  const prefix = `\x1b[${color}m[${name}]\x1b[0m `
  const pipe = (stream, out) => {
    let buf = ''
    stream.on('data', (chunk) => {
      buf += chunk.toString()
      let nl
      while ((nl = buf.indexOf('\n')) !== -1) {
        out.write(prefix + buf.slice(0, nl + 1))
        buf = buf.slice(nl + 1)
      }
    })
    stream.on('end', () => {
      if (buf) out.write(prefix + buf + '\n')
    })
  }
  pipe(child.stdout, process.stdout)
  pipe(child.stderr, process.stderr)
  child.on('exit', (code) => {
    // One side dying takes the other down — a half-running dev setup only
    // produces confusing proxy errors.
    shutdown(code ?? 0)
  })
  return child
}

let shuttingDown = false
function shutdown(code) {
  if (shuttingDown) return
  shuttingDown = true
  for (const p of procs) p.kill('SIGTERM')
  setTimeout(() => process.exit(code), 300)
}

process.on('SIGINT', () => shutdown(0))
process.on('SIGTERM', () => shutdown(0))

run('serve', '36', 'npx', ['tsx', 'watch', 'src/cli.ts', 'serve'])
run('web', '35', 'npx', ['vite', '--config', 'web/vite.config.ts'])
