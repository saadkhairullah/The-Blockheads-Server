#ifndef HOOK_ARENA_H
#define HOOK_ARENA_H

#include "bh_common.h"

// Initialize arena system (reads config for wave delay, max waves, loot)
void InitArenaSystem(void);

// Called from tick hook every frame
void UpdateArena(id dynWorld, float dt);

// Called from Hook_CaveTroll_Die when an NPC dies.
// Returns true if the NPC was an arena-tracked mob.
bool OnArenaNpcDeath(unsigned long long npcUid);

// Command handlers (called from hook_commands.c)
void HandleArenaSet(id server, int x1, int y1, int x2, int y2);
void HandleArenaStart(id server, id dynWorld);
void HandleArenaStop(id server);

#endif // HOOK_ARENA_H
