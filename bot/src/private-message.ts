import { appendFileSync } from 'fs'
import { config } from './config'

export function sendPrivateMessage(playerName: string, message: string): void {
  appendFileSync(config.paths.privateMessages, JSON.stringify({ target: playerName, message }) + '\n')
}
