import { MessageBot } from '@bhmb/bot'

MessageBot.registerExtension('server-messages', (ex) => {

  ex.world.onJoin.sub((player) => {
    ex.bot.send(`Welcome ${player.name}!`)
  })

  ex.world.onLeave.sub((player) => {
    ex.bot.send(`${player.name} has left the server!`)
  })

})
