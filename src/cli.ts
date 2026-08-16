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
    `Tokyo business-class award deal finder.\n${ATTRIBUTION} (${ATTRIBUTION_URL}).`,
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
  .option('--dry-run', 'print the digest instead of emailing; record no alert state', false)
  .option('--json', 'print detected deals as JSON', false)
  .action(async (opts: { dryRun: boolean; json: boolean }) => {
    const { searchCommand } = await import('./commands/search.js')
    await searchCommand(globalOpts(), opts)
  })

program
  .command('test-email')
  .description('send a canned digest through real SMTP to verify credentials')
  .action(async () => {
    const { testEmailCommand } = await import('./commands/testEmail.js')
    await testEmailCommand(globalOpts())
  })

program.parseAsync().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err))
  process.exitCode = 1
})
