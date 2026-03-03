import { Storage as AStorage } from '@bhmb/bot'
import { join } from 'path'
import { writeFile, readFileSync, existsSync } from 'fs'

const jsonPath = join(__dirname, '..', 'config', 'localStorage.json')
let fileStorage = new Map<string, string>()
let lastSave = Date.now()
let lastChange = 0

// Import the config JSON if the file exists
if (existsSync(jsonPath)) {
    let parsed: { [key: string]: string }
    try {
        let json = readFileSync(jsonPath, 'utf8')
        parsed = JSON.parse(json)

        if (parsed) { // Could be null
            for (let key of Object.keys(parsed)) {
                fileStorage.set(key, parsed[key])
            }
        }
    } catch (e) {
        console.error('Error importing localStorage.json', e)
    }
}

// Write at most every 30 seconds (async to avoid blocking event loop)
setInterval(() => {
    if (lastChange > lastSave) {
        lastSave = Date.now()
        let objMap: { [key: string]: string } = {}

        for (let [key, value] of fileStorage.entries()) {
            objMap[key] = value
        }

        writeFile(jsonPath, JSON.stringify(objMap, null, 4), 'utf8', (err) => {
            if (err) {
                console.error('Failed to save config', err)
            }
        })
    }
}, 30 * 1000)

export class Storage extends AStorage {
    constructor(private head: string = '') {
        super()
        this.head += '/'
    }

    get<T>(key: string, fallback: T): T {
        let result
        try {
            result = JSON.parse(fileStorage.get(this.head + key) || '') as T
        } catch {
            result = fallback
        }
        return result == null ? fallback : result
    }

    set(key: string, value: any): void {
        fileStorage.set(`${this.head}${key}`, JSON.stringify(value))
        lastChange = Date.now()
    }

    clear(prefix?: string): void {
        this.keys(prefix)
            .forEach(key => fileStorage.delete(this.head + key))
    }

    keys(prefix: string = ''): string[] {
        let keys: string[] = []
        for (let key of fileStorage.keys()) {
            if (key.startsWith(`${this.head}${prefix}`)) {
                keys.push(key)
            }
        }
        return keys.map(key => key.substr(this.head.length))
    }

    prefix(prefix: string): AStorage {
        return new Storage(this.head + prefix)
    }
}
