import { readFileSync, existsSync } from 'fs'
import { join, resolve } from 'path'
import { exit } from 'process'

// ============================================================================
// Configuration Types
// ============================================================================

export interface AppConfig {
  server: {
    user: string
    pass: string
    worldName: string
    worldId: string
  }
  paths: {
    worldSave: string
    python: string
    wildLocations: string
    privateMessages: string
    commandEvents: string
    serverLog: string
    inputPipe: string
    dataDir: string
  }
  game: {
    spawn: { x: number; y: number }
    arena: { x: number; y: number; radius: number }
    forbiddenItemIds: number[]
  }
  economy: {
    wildCost: number
    wildCooldownMs: number
    wildMinY: number
    wildMaxY: number
    wildMinSpawnDistance: number
    tpaCost: number
    tpaCooldownMs: number
    tpaExpireMs: number
    dailyReward: number
  }
  shop: ShopItemConfig[]
  jobs: JobConfig[]
}

export interface ShopItemConfig {
  key: string
  name: string
  itemId: number
  price: number
  count: number
  preferBasket?: boolean
}

export interface JobConfig {
  key: string
  name: string
  dailyPay: number
}

// ============================================================================
// Config Loading
// ============================================================================

const CONFIG_SEARCH_PATHS = [
  join(__dirname, '..', '..', 'config', 'config.json'),  // monorepo root: config/config.json
  join(__dirname, '..', 'config', 'config.json'),         // bot/config/config.json (legacy)
]

function loadConfigFile(): any {
  for (const configPath of CONFIG_SEARCH_PATHS) {
    if (existsSync(configPath)) {
      try {
        const raw = readFileSync(configPath, 'utf8')
        console.log(`[Config] Loaded config from ${configPath}`)
        return JSON.parse(raw)
      } catch (err) {
        console.error(`[Config] Failed to parse ${configPath}:`, err)
        exit(1)
      }
    }
  }
  console.error('[Config] No config.json found. Searched:', CONFIG_SEARCH_PATHS.join(', '))
  console.error('[Config] Copy config/config.example.json to config/config.json and fill in your values.')
  exit(1)
}

function envOr(envKey: string, fallback: string): string {
  return process.env[envKey] || fallback
}

function envNumOr(envKey: string, fallback: number): number {
  const val = process.env[envKey]
  if (val === undefined) return fallback
  const num = Number(val)
  return Number.isNaN(num) ? fallback : num
}

const parsed = loadConfigFile()

// Resolve paths relative to the monorepo root (two levels up from bot/build/)
const rootDir = resolve(__dirname, '..', '..')
const resolvePath = (p: string): string => {
  if (!p) return p
  if (p.startsWith('/') || p.startsWith('~')) return p
  return resolve(rootDir, p)
}

// ============================================================================
// Build the typed config with env var overrides
// ============================================================================

export const config: AppConfig = {
  server: {
    user: envOr('BH_SERVER_USER', parsed.server?.user ?? ''),
    pass: envOr('BH_SERVER_PASS', parsed.server?.pass ?? ''),
    worldName: envOr('BH_WORLD_NAME', parsed.server?.worldName ?? ''),
    worldId: envOr('BH_WORLD_ID', parsed.server?.worldId ?? ''),
  },
  paths: {
    worldSave: resolvePath(envOr('BH_WORLD_SAVE_PATH', parsed.paths?.worldSave ?? '')),
    python: envOr('BH_PYTHON_PATH', parsed.paths?.python ?? 'python3'),
    wildLocations: resolvePath(envOr('BH_WILD_LOCATIONS_PATH', parsed.paths?.wildLocations ?? './tools/wild_locations.py')),
    privateMessages: resolvePath(envOr('BH_PRIVATE_MSG_PATH', parsed.paths?.privateMessages ?? './data/private_messages.jsonl')),
    commandEvents: resolvePath(envOr('BH_COMMAND_EVENTS_PATH', parsed.paths?.commandEvents ?? './data/command_events.jsonl')),
    serverLog: resolvePath(envOr('BH_SERVER_LOG_PATH', parsed.paths?.serverLog ?? './data/blockheads.log')),
    inputPipe: resolvePath(envOr('BH_INPUT_PIPE_PATH', parsed.paths?.inputPipe ?? './data/blockheads_input')),
    dataDir: resolvePath(envOr('BH_DATA_DIR', parsed.paths?.dataDir ?? './data')),
  },
  game: {
    spawn: {
      x: envNumOr('BH_SPAWN_X', parsed.game?.spawn?.x ?? 0),
      y: envNumOr('BH_SPAWN_Y', parsed.game?.spawn?.y ?? 0),
    },
    arena: {
      x: envNumOr('BH_ARENA_X', parsed.game?.arena?.x ?? 0),
      y: envNumOr('BH_ARENA_Y', parsed.game?.arena?.y ?? 0),
      radius: envNumOr('BH_ARENA_RADIUS', parsed.game?.arena?.radius ?? 50),
    },
    forbiddenItemIds: parsed.game?.forbiddenItemIds ?? [1074, 206, 300],
  },
  economy: {
    wildCost: envNumOr('BH_WILD_COST', parsed.economy?.wildCost ?? 25),
    wildCooldownMs: envNumOr('BH_WILD_COOLDOWN_MS', parsed.economy?.wildCooldownMs ?? 300000),
    wildMinY: envNumOr('BH_WILD_MIN_Y', parsed.economy?.wildMinY ?? 521),
    wildMaxY: envNumOr('BH_WILD_MAX_Y', parsed.economy?.wildMaxY ?? 600),
    wildMinSpawnDistance: envNumOr('BH_WILD_MIN_SPAWN_DISTANCE', parsed.economy?.wildMinSpawnDistance ?? 5000),
    tpaCost: envNumOr('BH_TPA_COST', parsed.economy?.tpaCost ?? 0),
    tpaCooldownMs: envNumOr('BH_TPA_COOLDOWN_MS', parsed.economy?.tpaCooldownMs ?? 60000),
    tpaExpireMs: envNumOr('BH_TPA_EXPIRE_MS', parsed.economy?.tpaExpireMs ?? 90000),
    dailyReward: envNumOr('BH_DAILY_REWARD', parsed.economy?.dailyReward ?? 200),
  },
  shop: parsed.shop ?? [
    { key: 'diamond', name: 'Diamond', itemId: 88, price: 400, count: 1 },
  ],
  jobs: parsed.jobs ?? [
    { key: 'PUBLIC_BUILDER', name: 'Public Builder', dailyPay: 200 },
  ],
}

// ============================================================================
// Legacy exports (for existing config.ts consumers)
// ============================================================================

export const user: string = config.server.user
export const pass: string = config.server.pass
export const info = {
  name: config.server.worldName,
  id: config.server.worldId,
}
