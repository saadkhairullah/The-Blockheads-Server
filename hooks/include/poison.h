#ifndef POISON_H
#define POISON_H

#include "bh_common.h"

// Add a player to the poison list (or refresh if already poisoned)
void PoisonPlayer(unsigned long long uid);

// Process poison ticks — call once per game tick from boss update
// Applies damage to all poisoned players, removes expired entries
void ProcessPoisonTicks(id dynWorld);

// Initialize poison system (reads env vars)
void InitPoison(void);

#endif // POISON_H
