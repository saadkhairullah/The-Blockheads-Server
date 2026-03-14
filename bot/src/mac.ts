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

// Legacy extensions — require triggers MessageBot.registerExtension at module load
require('./extensions/server-messages')
require('./extensions/whisper')
require('./extensions/commands-help')

new BlockheadsBot(config)
  .use('server-messages')
  .use(VirtualBank)
  .use(ActivityMonitor)
  .use(QuestSystem)
  .use(ShopSystem)
  .use(TeleportSystem)
  .use(JobSystem)
  .use('whisper')
  .use('commands-help')
  .start()
