import { MessageBot } from '@bhmb/bot'
import * as fs from 'fs'
import type { AppConfig } from '../config'
import type { BotContext, ExtensionFactory } from '../bot-context'
import { isAdmin } from './helpers/isAdmin'
import { sendPrivateMessage } from '../private-message'

// Hook commands that need admin privileges
const ADMIN_HOOK_COMMANDS = [
  '/spawn-troll', '/spawn-boss',
  '/godmode', '/defense', '/buff',
  '/arena', '/claim-at', '/unclaim',
  '/give-id', '/give '
]

// Hook commands any player can use (duel is now bot-side via duel-system)
const PLAYER_HOOK_COMMANDS: string[] = []

export const HookCommands: ExtensionFactory = (_bot: BotContext, cfg: AppConfig): string => {
  MessageBot.registerExtension('hook-commands', (ex) => {
    ex.world.onMessage.sub(({ player, message }) => {
      const raw = message.trim()
      const lower = raw.toLowerCase()
      const playerName = player.name

      // Check if this is a hook command
      const isAdminCmd = ADMIN_HOOK_COMMANDS.some(c => lower.startsWith(c) || lower === c.trim())
      const isPlayerCmd = PLAYER_HOOK_COMMANDS.some(c => lower.startsWith(c) || lower === c.trim())

      if (!isAdminCmd && !isPlayerCmd) return

      // Admin commands require admin privileges
      if (isAdminCmd && !isAdmin(playerName)) return

      // Forward to server stdin — hook processes it with client=nil
      const cmd = raw + '\n'
      try {
        fs.appendFileSync(cfg.paths.inputPipe, cmd)
        console.log(`[HookCmd] Forwarded "${raw}" from ${playerName}`)
      } catch (err) {
        console.error('[HookCmd] Pipe write error:', err)
        sendPrivateMessage(playerName, 'Command failed (server pipe error).')
      }
    })
  })
  return 'hook-commands'
}
