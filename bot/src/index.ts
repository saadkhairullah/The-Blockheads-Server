import { join } from 'path'
import { spawn } from 'child_process'
import type { AppConfig } from './config'
import type { BotContext, ExtensionFactory } from './bot-context'

// ============================================================================
// BlockheadsBot — programmatic entry point for the framework
//
// Usage:
//   import { BlockheadsBot, loadConfig } from './index'
//   import { VirtualBank, ActivityMonitor } from './index'
//
//   new BlockheadsBot(loadConfig())
//     .use(VirtualBank)
//     .use(ActivityMonitor)
//     .use('server-messages')   // legacy name-only registration
//     .start()
// ============================================================================

export class BlockheadsBot {
  readonly config: AppConfig
  private _extensions: Array<ExtensionFactory | string> = []
  private _bot: any = null

  constructor(config: AppConfig) {
    this.config = config
  }

  /**
   * Register an extension. Pass an ExtensionFactory (for converted extensions)
   * or a plain string name (for legacy extensions registered via module-level
   * MessageBot.registerExtension calls).
   */
  use(factory: ExtensionFactory | string): this {
    this._extensions.push(factory)
    return this
  }

  /** Send a command/message to the game server. */
  send(message: string): void {
    if (this._bot) (this._bot as any).world.sendMessage(message)
  }

  /** Validate that all declared requires are satisfied before starting. */
  private _validate(): void {
    const registered = new Set<string>()
    for (const ext of this._extensions) {
      if (typeof ext === 'string') {
        registered.add(ext)
      } else if (ext.extensionName) {
        registered.add(ext.extensionName)
      }
    }
    for (const ext of this._extensions) {
      if (typeof ext === 'string' || !ext.requires) continue
      const name = ext.extensionName ?? '(unnamed factory)'
      for (const dep of ext.requires) {
        if (!registered.has(dep)) {
          throw new Error(`Extension "${name}" requires "${dep}" but it is not registered.\nRegistered: [${[...registered].join(', ')}]`)
        }
      }
    }
  }

  /**
   * Start the bot. Validates extension dependencies, spawns the Python daemon,
   * connects the WM socket, starts event dispatch, wires MessageBot, and loads
   * all registered extensions.
   */
  start(): void {
    this._validate()
    const cfg = this.config

    // Lazy requires keep module load side-effects isolated to start() time
    const { Api, getWorlds, watchChat, watchCommandEvents,
            setMessageCallback, setJoinCallback, setLeaveCallback, initApi } = require('./linux-api')
    const fetchLib = require('fetch-cookie').default(require('node-fetch'))
    const { MessageBot }     = require('@bhmb/bot')
    const { eventDispatcher } = require('./event-dispatcher')
    const { createWMClient }  = require('./wm-client')
    const { setWMClient }     = require('./blockhead-service')
    const { loadAdminList, watchAdminList } = require('./extensions/helpers/isAdmin')
    const { Storage: BotStorage } = require('./storage')
    const { initCommandSocket } = require('./private-message')

    // Connect to proxy command socket (bot → proxy: private messages, future commands)
    initCommandSocket(cfg.paths.proxyCommandSock)

    // Admin list — loaded once, watched for live changes
    loadAdminList(cfg.paths.worldSave)
    watchAdminList(cfg.paths.worldSave)

    // Wire config into linux-api before any Api instances are created
    initApi(cfg)

    // Spawn WorldManager daemon — auto-restarts on crash
    const daemonScript = join(__dirname, '..', '..', 'tools', 'uds_daemon.py')
    const spawnDaemon = () => {
      const daemon = spawn(cfg.paths.python, [daemonScript, cfg.paths.worldSave], {
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
      const wm = createWMClient(cfg.paths.wmSock)
      setWMClient(wm)
      eventDispatcher.start()
    }, 500)

    // Wire MessageBot
    const info = { name: cfg.server.worldName, id: cfg.server.worldId }
    MessageBot.dependencies = { Api, getWorlds, fetch: fetchLib }
    watchChat(cfg)
    watchCommandEvents(cfg)

    const bot = new MessageBot(new BotStorage(info.id), info)
    this._bot = bot

    const botCtx: BotContext = { config: cfg, send: (msg) => this.send(msg) }
    const worldAny = bot.world as any

    setMessageCallback((msg: any) => worldAny._events.onMessage.dispatch(msg))
    setJoinCallback((player: any) => {
      console.log('[Bot] Join event:', player.name)
      worldAny._events.onJoin.dispatch(player)
    })
    setLeaveCallback((player: any) => {
      console.log('[Bot] Leave event:', player.name)
      worldAny._events.onLeave.dispatch(player)
    })

    // Load all registered extensions
    for (const ext of this._extensions) {
      if (typeof ext === 'string') {
        bot.addExtension(ext)
      } else {
        bot.addExtension(ext(botCtx, cfg))
      }
    }

    console.log('Bot started.')
    bot.world.onMessage.sub(({ player, message }: { player: any; message: string }) =>
      console.log(player.name, message)
    )
  }
}

// ============================================================================
// Re-exports — public API surface (Phase 9 will expand this)
// ============================================================================

export { loadConfig } from './config'
export type { AppConfig, ShopItemConfig, JobConfig } from './config'
export type { BotContext, ExtensionFactory } from './bot-context'

export { VirtualBank }    from './extensions/virtual-bank'
export { ActivityMonitor } from './extensions/activity-monitor'
export { QuestSystem }    from './extensions/quest-system'
export { ShopSystem }     from './extensions/shop/shop-system'
export { TeleportSystem } from './extensions/teleport/teleport-system'
export { JobSystem }      from './extensions/job-system'
