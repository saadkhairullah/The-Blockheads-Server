#ifndef HOOK_DUEL_H
#define HOOK_DUEL_H

#include "bh_common.h"

// Duel states
typedef enum {
    DUEL_NONE,
    DUEL_PENDING,       // Challenge sent, waiting /accept
    DUEL_PREP,          // Accepted, waiting for bot to swap inventories + kick
    DUEL_WAIT_REJOIN,   // Players kicked, waiting for both to rejoin
    DUEL_COUNTDOWN,     // Both online with kit, countdown to fight
    DUEL_ACTIVE,        // Fight in progress
    DUEL_FINISHED,      // Winner decided, waiting for bot to restore inventories
    DUEL_RESTORING      // Bot restoring inventories, waiting for rejoin
} DuelState;

// Initialize duel system (reads config for timeouts)
void InitDuelSystem(void);

// Called from tick hook every frame
void UpdateDuelSystem(id dynWorld, float dt);

// Check if a blockhead UID is in an active duel
bool IsInActiveDuel(unsigned long long uid);

// Get the opponent UID if in active duel (for isolation check)
// Returns 0 if not in active duel
unsigned long long GetDuelOpponent(unsigned long long uid);

// Called when a PvP death is detected (from hook_godmode.c)
void OnDuelDeath(unsigned long long killerUid, unsigned long long victimUid);

// Command handlers (called from hook_commands.c)
// server: BHServer for SendChat. client: issuing client (nil for console).
void HandleDuelCommand(id server, id dynWorld, const char *targetName, id client);
void HandleAcceptCommand(id server, id dynWorld, id client);
void HandleDeclineCommand(id server, id dynWorld, id client);
void HandleDuelReady(id server, unsigned long long p1Uid, unsigned long long p2Uid);
void HandleDuelRestored(id server, unsigned long long p1Uid, unsigned long long p2Uid);

#endif // HOOK_DUEL_H
