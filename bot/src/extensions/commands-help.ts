import { MessageBot } from '@bhmb/bot'
import { sendPrivateMessage } from '../private-message'
import {  isAdmin as isAdminHelper } from './helpers/isAdmin'

MessageBot.registerExtension('commands-help', (ex) => {
  console.log('Commands Help extension loaded!')

  // Command documentation organized by category
  // Note: Bank commands (/balance, /pay, /cf, /transactions, /baltop, /daily)
  // are excluded since they're shown in /bank help
  const COMMAND_CATEGORIES = {
    shop: {
      name: 'Shop and Bank',
      commands: [
        { cmd: '/shop', desc: 'View available items for purchase' },
        { cmd: '/buy <item>', desc: 'Purchase an item from the shop' },
        { cmd: '/unknown', desc: 'Buy a random mystery item (50 tokens)' },
        { cmd: '/bank', desc: 'View all banking commands' },
      ]
    },
    quests: {
      name: 'Quests',
      commands: [
        { cmd: '/quest', alias: '/quests', desc: 'View your current quest and progress' },
        { cmd: '/claim', desc: 'Claim pending quest rewards' },
        { cmd: '/coords', desc: 'View your current coordinates' },
      ]
    },
    teleportation: {
      name: 'Teleportation',
      commands: [
        { cmd: '/spawn', desc: 'Teleport back to spawn' },
        { cmd: '/wild', desc: 'Teleport to random wilderness (50 tokens, 15min cooldown)' },
        { cmd: '/tpa <player>', desc: 'Request to teleport to a player (costs tokens)' },
        { cmd: '/tpaccept <player>', desc: 'Accept a teleport request' },
        { cmd: '/tpdeny <player>', desc: 'Deny a teleport request' },
        { cmd: '/coords', desc: 'View your current coordinates' },
        { cmd: '/tracked', desc: 'See which blockhead is being tracked for coords and quests' },
        { cmd: '/track <n>', desc: 'Choose which blockhead to use for coords and quests' },
      ]
    },
    jobs: {
      name: 'Jobs',
      commands: [
        { cmd: '/jobs', desc: 'View available jobs and requirements' },
        { cmd: '/apply <job> <discord>', desc: 'Apply for a job (requires quest 10)' },
        { cmd: '/rep <message>', desc: 'Submit your weekly work report' },
      ]
    },
    social: {
      name: 'Social',
      commands: [
        { cmd: '/whisper <player> <msg>', alias: '/w', desc: 'Send a private message to a player' },
      ]
    },
  }

  const ADMIN_COMMANDS = {
    quests: [
      { cmd: '/questskip', desc: 'Skip to the next quest' },
      { cmd: '/seasonreset', desc: 'Reset all player quest progress for a new season' },
       { cmd: '/give <player> <itemid> <amount>', desc: 'Give an item to a player' },
    ],
    teleportation: [
      { cmd: '/tp <x> <y>', desc: 'Teleport to specific coordinates' },
    ],
    jobs: [
      { cmd: '/hire <player> <job>', desc: 'Hire a player for a job' },
      { cmd: '/reject <player> [reason]', desc: 'Reject a job application' },
      { cmd: '/fire <player> [reason]', desc: 'Fire an employee' },
      { cmd: '/promote <player> <pay>', desc: 'Change employee daily pay' },
    ],
  }

  // Format a single command entry
  const formatCommand = (cmd: { cmd: string, alias?: string, desc: string }): string => {
    const aliasStr = cmd.alias ? ` (${cmd.alias})` : ''
    return `  ${cmd.cmd}${aliasStr} - ${cmd.desc}`
  }

  // Build the commands list for a player
  const buildCommandsList = (playerName: string): string[] => {
    const messages: string[] = []
    const isAdmin = isAdminHelper(playerName)


    // Regular commands by category
    for (const [categoryKey, category] of Object.entries(COMMAND_CATEGORIES)) {
      let categoryText = `\n--- ${category.name} ---\n`

      for (const cmd of category.commands) {
        categoryText += formatCommand(cmd) + '\n'
      }

      // Add admin commands for this category if player is admin
      if (isAdmin && ADMIN_COMMANDS[categoryKey as keyof typeof ADMIN_COMMANDS]) {
        categoryText += '  [Admin]\n'
        for (const cmd of ADMIN_COMMANDS[categoryKey as keyof typeof ADMIN_COMMANDS]) {
          categoryText += formatCommand(cmd) + '\n'
        }
      }

      messages.push(categoryText.trim())
    }
    messages.push('=== Available Commands ===')
    return messages
  }

  // Handle /commands and /cmds
  ex.world.onMessage.sub(({ player, message }) => {
    const msg = message.trim().toLowerCase()

    if (msg !== '/commands' && msg !== '/cmds') return

    const commandsList = buildCommandsList(player.name)

    // Send each section as a separate private message to avoid message length limits
    for (const section of commandsList) {
      if (section.trim()) {
        sendPrivateMessage(player.name, section)
      }
    }

    console.log(`[Commands] ${player.name} requested command list`)
  })

  // Handle category-specific help
  ex.world.onMessage.sub(({ player, message }) => {
    const msg = message.trim().toLowerCase()

    if (!msg.startsWith('/commands ')) return

    const categoryArg = msg.split(' ')[1]
    const category = COMMAND_CATEGORIES[categoryArg as keyof typeof COMMAND_CATEGORIES]

    if (!category) {
      const validCategories = Object.keys(COMMAND_CATEGORIES).join(', ')
      sendPrivateMessage(player.name, `Unknown category. Valid categories: ${validCategories}`)
      return
    }

    let response = `--- ${category.name} Commands ---\n`
    for (const cmd of category.commands) {
      response += formatCommand(cmd) + '\n'
    }

    // Add admin commands if applicable
    const isAdmin = isAdminHelper(player.name)
    if (isAdmin && ADMIN_COMMANDS[categoryArg as keyof typeof ADMIN_COMMANDS]) {
      response += '\n[Admin Commands]\n'
      for (const cmd of ADMIN_COMMANDS[categoryArg as keyof typeof ADMIN_COMMANDS]) {
        response += formatCommand(cmd) + '\n'
      }
    }

    sendPrivateMessage(player.name, response.trim())
  })

  ex.remove = () => {
    console.log('Commands Help extension removed')
  }
})
