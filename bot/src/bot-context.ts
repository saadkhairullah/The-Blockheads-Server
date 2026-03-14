import type { AppConfig } from './config'

/**
 * Public interface exposed to extension factories.
 * Extensions receive this instead of importing global singletons.
 * BlockheadsBot implements this interface.
 */
export interface BotContext {
  readonly config: AppConfig
  send(message: string): void
}

/**
 * Extension factory — callable interface with optional dependency metadata.
 *
 * - Call it as a function: name = factory(bot, cfg)
 * - Optionally declare: factory.extensionName and factory.requires
 *
 * BlockheadsBot.start() validates all requires are registered before loading anything.
 */
export interface ExtensionFactory {
  (bot: BotContext, cfg: AppConfig): string
  /** The @bhmb/bot extension name this factory registers (for dependency validation). */
  extensionName?: string
  /** Names of extensions that must be registered before this one. */
  requires?: readonly string[]
}
