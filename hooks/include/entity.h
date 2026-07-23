#ifndef ENTITY_H
#define ENTITY_H

#include "bh_common.h"

// Find a blockhead in netBlockheads by player/client name (case-insensitive)
id FindBlockhead(id dynWorld, const char* name);

// Find a blockhead in netBlockheads by uniqueID (uint64_t at offset 0x40)
id FindBlockheadById(id dynWorld, unsigned long long uid);

// Find a blockhead by display name (the in-game blockhead name, case-insensitive)
// Returns the blockhead object, or nil if not found
id FindBlockheadByDisplayName(id dynWorld, const char* displayName);

// Find ALL blockheads owned by a player (by clientName, case-insensitive)
// Fills outBlockheads[] with up to maxResults blockhead objects
// Returns the number found
#define MAX_BLOCKHEADS_PER_PLAYER 5
int FindAllBlockheadsByClientName(id dynWorld, const char* clientName, id *outBlockheads, int maxResults);

// Get a blockhead's clientID (UUID at offset 0xc0) as a C string.
// Returns a pointer to an internal buffer (valid until next call). Returns NULL on failure.
const char* GetBlockheadClientId(id blockhead);

// Spawn an item (FreeBlock) at a player's position
void SpawnItem(id dynWorld, id player, int itemId, int count);

// Native teleport — calls Blockhead::teleportToPos: with canTeleport bypass
// Returns 1 on success, 0 on failure
int TeleportBlockhead(id blockhead, int x, int y);

#endif // ENTITY_H
