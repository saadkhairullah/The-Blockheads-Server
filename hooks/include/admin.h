#ifndef ADMIN_H
#define ADMIN_H

#include "bh_common.h"

// Check if a player name is in the admin list.
// Reads from BH_ADMIN_LIST_PATH env var, or falls back to default path.
bool IsAdmin(const char* name);

#endif // ADMIN_H
