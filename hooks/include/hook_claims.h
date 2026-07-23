#ifndef HOOK_CLAIMS_H
#define HOOK_CLAIMS_H

#include "bh_common.h"

// Place an ownership sign at the given position, owned by the specified player.
// radius: 1-15 (default 15, max per axis)
// ownerName: display name for the claim (shown in-game)
// ownerClientId: unique client ID for protection checks (can be same as ownerName)
// Returns true on success.
bool PlaceOwnershipSign(id dynWorld, int x, int y, const char *ownerName,
                        const char *ownerClientId, int radius);

// Remove an ownership sign at the given position.
// Returns true if a sign was found and removed.
bool RemoveOwnershipSign(id dynWorld, int x, int y);

#endif // HOOK_CLAIMS_H
