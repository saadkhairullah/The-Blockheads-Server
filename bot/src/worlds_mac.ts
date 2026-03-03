require = require('@std/esm')(module)

import { getWorlds } from 'blockheads-api/mac'

async function main() {
    console.log('Worlds:')
    console.log('name -- id')
    for (let world of await getWorlds()) {
        console.log(world.name, '--', world.id)
    }
}

main()
