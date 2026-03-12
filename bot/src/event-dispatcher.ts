import { getUDSClient } from './uds-client'
import { ActivityEvent } from './extensions/types/shared-types'

type GameEvent = ActivityEvent
type EventHandler = (event: GameEvent) => void

/**
 * Central fan-out dispatcher for UDS events from the Java proxy.
 * Holds the single getUDSClient().on('event', ...) subscription and
 * routes events to all registered handlers.
 *
 * Usage:
 *   eventDispatcher.subscribeAll(handler)        // all event types
 *   eventDispatcher.subscribe('PLAYER_MOVE', h)  // specific type
 *   eventDispatcher.start()                      // call once at startup
 */
class EventDispatcher {
  private allHandlers: EventHandler[] = []
  private typedHandlers: Map<string, EventHandler[]> = new Map()
  private started = false

  subscribeAll(handler: EventHandler): void {
    this.allHandlers.push(handler)
  }

  subscribe(eventType: string, handler: EventHandler): void {
    const existing = this.typedHandlers.get(eventType)
    if (existing) {
      existing.push(handler)
    } else {
      this.typedHandlers.set(eventType, [handler])
    }
  }

  start(): void {
    if (this.started) return
    this.started = true
    getUDSClient().on('event', (event: any) => {
      this.dispatch(event as GameEvent)
    })
  }

  private dispatch(event: GameEvent): void {
    for (const handler of this.allHandlers) {
      try {
        handler(event)
      } catch (err) {
        console.error('[EventDispatcher] Handler error:', err)
      }
    }
    const typed = this.typedHandlers.get(event.type)
    if (typed) {
      for (const handler of typed) {
        try {
          handler(event)
        } catch (err) {
          console.error('[EventDispatcher] Typed handler error:', err)
        }
      }
    }
  }
}

export const eventDispatcher = new EventDispatcher()
