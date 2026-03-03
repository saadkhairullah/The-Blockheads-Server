require = require('@std/esm')(module)

import { setFetch, login, getWorlds } from 'blockheads-api/cloud'
setFetch(require('fetch-cookie/node-fetch')(require('node-fetch')))

import { user, pass } from './config'

async function main() {
    try {
        console.log(`Logging in as ${user} with password ${pass.replace(/./g, '*')}`)
        await login(user, pass)
    } catch {
        console.log('Invalid username / password')
        return
    }

    console.log('Worlds:')
    console.log('name -- id')
    for (let world of await getWorlds()) {
        console.log(world.name, '--', world.id)
    }
}

main()
