const fs = require('fs')
const path = require('path')
const { config } = require('./config')
const { BlockheadsBot } = require('./index')

// SIGUSR2 -> dump V8 stack trace to file (send: kill -USR2 <pid>)
process.on('SIGUSR2', () => {
  const trace = new Error().stack || 'no stack'
  const pending = (process as any)._tickCallback ? 'yes' : 'no'
  const dump = `=== SIGUSR2 STACK DUMP ${new Date().toISOString()} ===\n` +
    `pending microtasks: ${pending}\n` +
    `${trace}\n\n` +
    `=== PENDING PROMISES (approximate) ===\n` +
    `${JSON.stringify(process.memoryUsage(), null, 2)}\n`
  const dumpPath = path.join(config.paths.dataDir, 'node-stack-dump.txt')
  fs.writeFileSync(dumpPath, dump)
  fs.appendFileSync(dumpPath, dump)
  console.error(`[DEBUG] Stack dumped to ${dumpPath}`)
})

// Factory-based extensions
const { VirtualBank }     = require('./extensions/virtual-bank')
const { ActivityMonitor } = require('./extensions/activity-monitor')
const { QuestSystem }     = require('./extensions/quest-system')
const { ShopSystem }      = require('./extensions/shop/shop-system')
const { TeleportSystem }  = require('./extensions/teleport/teleport-system')
const { JobSystem }       = require('./extensions/job-system')
const { DuelSystem }     = require('./extensions/duel/duel-system')
const { ClaimsSystem }   = require('./extensions/claims-system')
const { HookCommands }   = require('./extensions/hook-commands')
const { BuffShop }       = require('./extensions/buff-shop')
const { BossRewards }    = require('./extensions/boss-rewards')

// Legacy extensions — require triggers MessageBot.registerExtension at module load
require('./extensions/server-messages')
require('./extensions/whisper')
require('./extensions/commands-help')

const ext = (config as any).extensions || {}
const isEnabled = (name: string) => ext[name] !== false  // default true

const bot = new BlockheadsBot(config)
  .use('server-messages')  // always — core infrastructure

if (isEnabled('virtual-bank'))     bot.use(VirtualBank)
if (isEnabled('activity-monitor')) bot.use(ActivityMonitor)
if (isEnabled('quest-system'))     bot.use(QuestSystem)
if (isEnabled('shop-system'))      bot.use(ShopSystem)
if (isEnabled('teleport-system'))  bot.use(TeleportSystem)
if (isEnabled('job-system'))       bot.use(JobSystem)
if (isEnabled('duel-system'))      bot.use(DuelSystem)
if (isEnabled('claims-system'))    bot.use(ClaimsSystem)
if (isEnabled('hook-commands'))    bot.use(HookCommands)
if (isEnabled('buff-shop'))        bot.use(BuffShop)
if (isEnabled('boss-rewards'))     bot.use(BossRewards)
if (isEnabled('whisper'))          bot.use('whisper')
if (isEnabled('commands-help'))    bot.use('commands-help')

bot.start()
