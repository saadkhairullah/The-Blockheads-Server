const { MessageBot } = require('@bhmb/bot')

MessageBot.registerExtension('test', (ex) => {
    console.log('Test extension loaded!')
    
    // Listen to chat messages
    ex.world.onMessage.sub(({ player, message }) => {
        console.log(`[Test Extension] ${player.name}: ${message}`)
        
        // Respond to /ping
        if (message.toLowerCase() === '/ping') {
            ex.bot.send(`Pong! Hello ${player.name}!`)
        }
        
        // Respond to /test
        if (message.toLowerCase().startsWith('/test')) {
            const args = message.substring(5).trim()
            ex.bot.send(`Test command received! You said: ${args || '(nothing)'}`)
        }
        
        // Respond to /marco
        if (message.toLowerCase() === '/marco') {
            ex.bot.send('Polo!')
        }
    })
    
    // Cleanup when extension is removed
    ex.remove = () => {
        console.log('Test extension removed')
    }
})