import { MessageBot } from '@bhmb/bot'
import { sendPrivateMessage } from '../private-message'
import { isAdmin as isAdminHelper } from './helpers/isAdmin'
import { getCategories } from './helpers/command-registry'

MessageBot.registerExtension('commands-help', (ex) => {
  console.log('Commands Help extension loaded!')

  const formatCommand = (cmd: { cmd: string; alias?: string; desc: string }): string => {
    const aliasStr = cmd.alias ? ` (${cmd.alias})` : ''
    return `  ${cmd.cmd}${aliasStr} - ${cmd.desc}`
  }

  const buildCommandsList = (playerName: string): string[] => {
    const isAdmin = isAdminHelper(playerName)
    const messages: string[] = ['=== Available Commands ===']

    for (const [, category] of getCategories()) {
      let text = `\n--- ${category.name} ---\n`
      for (const cmd of category.player) text += formatCommand(cmd) + '\n'
      if (isAdmin && category.admin?.length) {
        text += '  [Admin]\n'
        for (const cmd of category.admin) text += formatCommand(cmd) + '\n'
      }
      messages.push(text.trim())
    }

    return messages
  }

  // /cmds or /commands — full list
  ex.world.onMessage.sub(({ player, message }) => {
    const msg = message.trim().toLowerCase()
    if (msg !== '/commands' && msg !== '/cmds') return

    for (const section of buildCommandsList(player.name)) {
      if (section.trim()) sendPrivateMessage(player.name, section)
    }
    console.log(`[Commands] ${player.name} requested command list`)
  })

  // /commands <category> — single category
  ex.world.onMessage.sub(({ player, message }) => {
    const msg = message.trim().toLowerCase()
    if (!msg.startsWith('/commands ')) return

    const categoryArg = msg.split(' ')[1]
    const category = getCategories().get(categoryArg)

    if (!category) {
      const valid = Array.from(getCategories().keys()).join(', ')
      sendPrivateMessage(player.name, `Unknown category. Valid: ${valid}`)
      return
    }

    const isAdmin = isAdminHelper(player.name)
    let response = `--- ${category.name} ---\n`
    for (const cmd of category.player) response += formatCommand(cmd) + '\n'
    if (isAdmin && category.admin?.length) {
      response += '\n[Admin]\n'
      for (const cmd of category.admin) response += formatCommand(cmd) + '\n'
    }
    sendPrivateMessage(player.name, response.trim())
  })

  ex.remove = () => { console.log('Commands Help extension removed') }
})
