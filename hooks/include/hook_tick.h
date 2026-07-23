#ifndef HOOK_TICK_H
#define HOOK_TICK_H

// Initialize DynamicWorld::update:accurateDT:isSimulation: hook.
// Provides a central tick dispatcher for all subsystems that need
// periodic updates (poison, duel, arena) independent of boss troll existence.
void InitTickHook(void);

#endif // HOOK_TICK_H
