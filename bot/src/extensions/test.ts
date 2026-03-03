import { MessageBot } from '@bhmb/bot'

MessageBot.registerExtension('test', (ex) => {

 ex.world.onJoin.sub((player) => {
        ex.bot.send(`Welcome ${player.name}!`)
    })
    
    
    ex.world.onLeave.sub((player) => {
        ex.bot.send(`${player.name} has left the server!`) 
    })
    
    // Cleanup when extension is removed
    ex.remove = () => {
        console.log('Test extension removed')
    }
})