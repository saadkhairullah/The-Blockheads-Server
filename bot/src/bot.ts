import { MessageBot as Bot } from '@bhmb/bot'

// Custom bot class to support splitting messages

export class MessageBot extends Bot implements Bot {
    send(message: string, { ...params }: { [key: string]: string } = {}): void {
        let messages: string[]
        // Split the message if splitting is enabled.
        if (this.storage.get('splitMessages', false)) {
            messages = message.split(this.storage.get('splitToken', '<split>'))
        } else {
            messages = [message]
        }

        for (let msg of messages) {
            super.send(msg, params)
        }
    }
}