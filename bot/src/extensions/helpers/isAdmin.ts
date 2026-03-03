import { readFile } from "fs/promises"
import { join } from "path"
import { watch } from "fs"
import { config } from '../../config'

const adminListPath = join(config.paths.worldSave, "adminlist.txt")

// Admin allowlist - loaded from adminlist.txt (case-insensitive)
let adminAllowlist: Set<string> = new Set()

export const loadAdminList = async () => {
    try {
      const content = await readFile(adminListPath, 'utf8')
      const lines = content.split('\n')
      // Skip first line (comment), trim whitespace, lowercase for case-insensitive matching
      adminAllowlist = new Set(
        lines.slice(1)
          .map(line => line.trim().toLowerCase())
          .filter(name => name.length > 0)
      )
      console.log(`[AdminList] Loaded ${adminAllowlist.size} admins from adminlist.txt`)
    } catch (err) {
      console.error('[AdminList] Failed to load adminlist.txt:', err)
    }
  }

export const watchAdminList = () => {
  try {
    watch(adminListPath, { persistent: false }, () => {
      void loadAdminList()
    })
  } catch (err) {
    console.error('[AdminList] Failed to watch adminlist.txt:', err)
  }
}

export const isAdmin = (playerName: string | undefined | null) => {
  if (!playerName) return false
  return adminAllowlist.has(playerName.trim().toLowerCase())
}
