import { MessageBot } from '@bhmb/bot'
import { sendPrivateMessage } from '../private-message'

MessageBot.registerExtension('whisper', (ex) => {
  ex.world.onMessage.sub(({ player, message }) => {
    if (!message.startsWith('/whisper ') && !message.startsWith('/w ')) return

    const parts = message.split(' ')
    const targetName = (parts[1] || '').trim()
    const text = parts.slice(2).join(' ').trim()

    if (!targetName || !text) {
      sendPrivateMessage(player.name, 'Usage: /whisper <player> <message>')
      return
    }

    if (targetName.toLowerCase() === player.name.toLowerCase()) {
      sendPrivateMessage(player.name, 'You cannot whisper to yourself.')
      return
    }

    sendPrivateMessage(targetName, `[whisper] ${player.name}: ${text}`)
    sendPrivateMessage(player.name, `[whisper] to ${targetName}: ${text}`)
  })
})
