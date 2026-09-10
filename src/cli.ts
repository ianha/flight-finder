#!/usr/bin/env node
import { Command } from 'commander'
import { ATTRIBUTION, ATTRIBUTION_URL } from './shared/constants.js'
import { loadDotEnv } from './config.js'
import { setVerbose } from './log.js'

loadDotEnv()

const program = new Command()

program
  .name('deal-finder')
  .description(
    `Business-class award deal finder (Tokyo by default; see search.destinations).\n${ATTRIBUTION} (${ATTRIBUTION_URL}).`,
  )
  .option('-c, --config <path>', 'config file path', './config.yaml')
  .option('--verbose', 'verbose logging', false)
  .hook('preAction', (thisCommand) => {
    setVerbose(Boolean(thisCommand.opts().verbose))
  })

export interface GlobalOpts {
  config: string
  verbose: boolean
}

function globalOpts(): GlobalOpts {
  return program.opts() as GlobalOpts
}

program
  .command('search')
  .description('run one poll cycle now (fetch, detect, alert)')
  .option('--dry-run', 'print the digest instead of texting; record no alert state', false)
  .option('--json', 'print detected deals as JSON', false)
  .action(async (opts: { dryRun: boolean; json: boolean }) => {
    const { searchCommand } = await import('./commands/search.js')
    await searchCommand(globalOpts(), opts)
  })

program
  .command('serve')
  .description('run the always-on service: internal scheduler + local web console (127.0.0.1)')
  .action(async () => {
    const { serveCommand } = await import('./commands/serve.js')
    await serveCommand(globalOpts())
  })

program
  .command('test-sms')
  .description('send a canned digest through Twilio to verify credentials and numbers')
  .action(async () => {
    const { testSmsCommand } = await import('./commands/testSms.js')
    await testSmsCommand(globalOpts())
  })

program
  .command('status')
  .description('quota usage, last cycle, data freshness, recent alerts')
  .action(async () => {
    const { statusCommand } = await import('./commands/status.js')
    await statusCommand(globalOpts())
  })

program
  .command('routes-audit')
  .description('per-route crawl-horizon report (how far out seats.aero actually covers the grid)')
  .action(async () => {
    const { routesAuditCommand } = await import('./commands/routesAudit.js')
    await routesAuditCommand(globalOpts())
  })

program
  .command('probe-british')
  .description('empirically test whether the undocumented BA Avios source works in the API')
  .action(async () => {
    const { probeBritishCommand } = await import('./commands/probeBritish.js')
    await probeBritishCommand(globalOpts())
  })

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
