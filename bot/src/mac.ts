const fs = require('fs')
const path = require('path')
const { config } = require('./config')

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

const { Api, getWorlds, watchChat, watchCommandEvents, setMessageCallback, setJoinCallback, setLeaveCallback } = require('./linux-api')
const fetchLib = require('fetch-cookie').default(require('node-fetch'))
const { MessageBot } = require('@bhmb/bot')
const { spawn } = require('child_process')
const { eventDispatcher } = require('./event-dispatcher')
const { getWMClient } = require('./wm-client')

// Load admin list once before extensions initialize
const { loadAdminList, watchAdminList } = require('./extensions/helpers/isAdmin')
loadAdminList()
watchAdminList()

// Spawn WorldManager daemon — restarts automatically if it crashes
const daemonScript = path.join(__dirname, '..', '..', 'tools', 'uds_daemon.py')
function spawnDaemon() {
  const daemon = spawn(config.paths.python, [daemonScript, config.paths.worldSave], {
    stdio: ['ignore', 'inherit', 'inherit'],
  })
  daemon.on('exit', (code: number | null) => {
    console.warn(`[WM Daemon] Exited with code ${code}, restarting in 2s...`)
    setTimeout(spawnDaemon, 2000)
  })
  console.log('[WM Daemon] Started')
}
spawnDaemon()

// Give daemon 500ms to bind the socket before connecting
setTimeout(() => {
  getWMClient()           // connect to WorldManager daemon
  eventDispatcher.start() // subscribe to UDS game events
}, 500)

require('./extensions/server-messages')
require('./extensions/virtual-bank')
require('./extensions/activity-monitor')
require('./extensions/quest-system')
require('./extensions/shop/shop-system')
require('./extensions/teleport/teleport-system')
require('./extensions/job-system')
require('./extensions/whisper')
require('./extensions/commands-help')
const { Storage: BotStorage } = require('./storage')
const { info } = require('./config')

MessageBot.dependencies = { Api, getWorlds, fetch: fetchLib }
watchChat()
watchCommandEvents()

let bot = new MessageBot(new BotStorage(info.id), info)

const worldAny = bot.world as any

// Connect message events
setMessageCallback((msg : any) => {
  worldAny._events.onMessage.dispatch(msg)
})

// Connect join events
setJoinCallback((player : any) => {
  console.log('[mac.ts] Join event:', player.name)
  worldAny._events.onJoin.dispatch(player)
})

// Connect leave events
setLeaveCallback((player : any) => {
  console.log('[mac.ts] Leave event:', player.name)
  worldAny._events.onLeave.dispatch(player)
})

bot.addExtension('server-messages')
bot.addExtension('virtual-bank')
bot.addExtension('activity-monitor')
bot.addExtension('quest-system')
bot.addExtension('shop-system')
bot.addExtension('teleport-system')
bot.addExtension('job-system')
bot.addExtension('whisper')
bot.addExtension('commands-help')
console.log('Bot started.')
bot.world.onMessage.sub(({player, message}: {player: any, message: string}) => console.log(player.name, message))
