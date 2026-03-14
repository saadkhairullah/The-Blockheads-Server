export interface CmdEntry { cmd: string; alias?: string; desc: string }
export interface CategoryEntry { name: string; player: CmdEntry[]; admin?: CmdEntry[] }

const _registry = new Map<string, CategoryEntry>()

export const registerCategory = (key: string, entry: CategoryEntry): void => {
  _registry.set(key, entry)
}

export const getCategories = (): ReadonlyMap<string, CategoryEntry> => _registry
