#include "bh_common.h"
#include "objc_helpers.h"
#include "admin.h"
#include "poison.h"
#include "hook_config.h"
#include <math.h>

// Reject NaN/infinity, clamp to [0, max]
static float clamp_valid(float v, float max) {
    if (isnan(v) || isinf(v) || v < 0.0f) return 0.0f;
    return v > max ? max : v;
}

// =============================================================================
// Dynamic Buff/Defense System + PvP Death Detection
//
// Replaces the old toggle-based god mode and buff with per-player numeric values:
//
//   Defense: 0-100 (percentage of incoming damage blocked)
//     100 = full god mode (health/fullness/energy restored, damage skipped)
//     95  = 95% blocked (take only 5% of incoming damage)
//     0   = no defense (normal)
//
//   Buff: multiplier on outgoing attack force
//     90  = 90x attack
//     5   = 5x attack (old default)
//     0   = remove buff (normal 1x)
//
// Uses uniqueID (uint64 at DynamicObject +0x40) for identification.
//
// PvP Death Detection:
//   Tracks last attacker per blockhead in hitWithForce.
//   Checks health <= 0 after sufferDamage to detect kills.
//   Announces kills via SendChat for bot integration.
//
// Commands (admin-only, in hook_commands.c):
//   /buff <name> <multiplier>   — set attack multiplier (0 to remove)
//   /defense <name> <percent>   — set defense % (0 to remove, 100 = god mode)
//   /godmode <name>             — shortcut for /defense <name> 100 (toggle)
// =============================================================================

#define MAX_ENTRIES 32
#define UNIQUEID_OFFSET 0x40

// --- Per-player modifier entry ---
typedef struct {
    unsigned long long uid;
    float value;
} PlayerMod;

// --- Defense list ---
static PlayerMod g_defenses[MAX_ENTRIES];
static int g_defenseCount = 0;

void SetDefense(unsigned long long uid, float value) {
    value = clamp_valid(value, 100.0f);  // defense: 0-100%
    // Update existing
    for (int i = 0; i < g_defenseCount; i++) {
        if (g_defenses[i].uid == uid) {
            if (value <= 0.0f) {
                // Remove
                g_defenses[i] = g_defenses[--g_defenseCount];
            } else {
                g_defenses[i].value = value;
            }
            return;
        }
    }
    // Add new
    if (value <= 0.0f) return;
    if (g_defenseCount >= MAX_ENTRIES) return;
    g_defenses[g_defenseCount].uid = uid;
    g_defenses[g_defenseCount].value = value;
    g_defenseCount++;
}

float GetDefense(unsigned long long uid) {
    for (int i = 0; i < g_defenseCount; i++) {
        if (g_defenses[i].uid == uid) return g_defenses[i].value;
    }
    return 0.0f;
}

// --- Buff list ---
static PlayerMod g_buffs[MAX_ENTRIES];
static int g_buffCount = 0;

void SetBuff(unsigned long long uid, float value) {
    value = clamp_valid(value, 100.0f);  // buff multiplier: 0-100x
    for (int i = 0; i < g_buffCount; i++) {
        if (g_buffs[i].uid == uid) {
            if (value <= 0.0f) {
                g_buffs[i] = g_buffs[--g_buffCount];
            } else {
                g_buffs[i].value = value;
            }
            return;
        }
    }
    if (value <= 0.0f) return;
    if (g_buffCount >= MAX_ENTRIES) return;
    g_buffs[g_buffCount].uid = uid;
    g_buffs[g_buffCount].value = value;
    g_buffCount++;
}

float GetBuff(unsigned long long uid) {
    for (int i = 0; i < g_buffCount; i++) {
        if (g_buffs[i].uid == uid) return g_buffs[i].value;
    }
    return 0.0f;
}

// --- Backward compat wrappers (used by existing /godmode command) ---
bool ToggleGodModeId(unsigned long long uid) {
    float def = GetDefense(uid);
    if (def >= 100.0f) {
        SetDefense(uid, 0.0f);
    } else {
        SetDefense(uid, 100.0f);
    }
    return true;
}

bool IsGodModeId(unsigned long long uid) {
    return GetDefense(uid) >= 100.0f;
}

bool ToggleBuffId(unsigned long long uid) {
    float buff = GetBuff(uid);
    if (buff > 0.0f) {
        SetBuff(uid, 0.0f);
    } else {
        SetBuff(uid, 5.0f);
    }
    return true;
}

bool IsBuffedId(unsigned long long uid) {
    return GetBuff(uid) > 0.0f;
}

// =============================================================================
// PvP Death Detection — last attacker tracking
// =============================================================================
#define MAX_TRACKED 64

typedef struct {
    unsigned long long victimUid;
    unsigned long long attackerUid;
} LastAttacker;

static LastAttacker g_lastAttacker[MAX_TRACKED];
static int g_lastAttackerCount = 0;

static void SetLastAttacker(unsigned long long victim, unsigned long long attacker) {
    for (int i = 0; i < g_lastAttackerCount; i++) {
        if (g_lastAttacker[i].victimUid == victim) {
            g_lastAttacker[i].attackerUid = attacker;
            return;
        }
    }
    if (g_lastAttackerCount >= MAX_TRACKED) {
        // Overwrite oldest (ring)
        g_lastAttacker[0].victimUid = victim;
        g_lastAttacker[0].attackerUid = attacker;
        return;
    }
    g_lastAttacker[g_lastAttackerCount].victimUid = victim;
    g_lastAttacker[g_lastAttackerCount].attackerUid = attacker;
    g_lastAttackerCount++;
}

unsigned long long GetLastAttacker(unsigned long long victim) {
    for (int i = 0; i < g_lastAttackerCount; i++) {
        if (g_lastAttacker[i].victimUid == victim)
            return g_lastAttacker[i].attackerUid;
    }
    return 0;
}

// =============================================================================
// Hook 1: sufferDamage — defense + boss damage + PvP death detection
// =============================================================================
typedef void (*SufferDamageFunc)(id, SEL, float, BOOL, int);
static SufferDamageFunc Orig_SufferDamage = NULL;

// Boss damage multiplier — set by hook_cavetroll.c during boss update calls
float g_bossDamageMultiplier = 1.0f;
bool g_bossDamageActive = false;

static void Hook_SufferDamage(id self, SEL _cmd, float damage, BOOL isSimulation, int recoil) {
    unsigned long long uid = *(unsigned long long *)((char *)self + UNIQUEID_OFFSET);

    // --- Defense system ---
    float defense = GetDefense(uid);
    if (defense >= 100.0f) {
        // Full god mode — restore stats, skip damage
        *(float *)((char *)self + 0x70) = 1.0f;  // health
        *(float *)((char *)self + 0x78) = 1.0f;  // fullness
        *(float *)((char *)self + 0x7C) = 1.0f;  // energy
        return;
    }
    if (defense > 0.0f) {
        damage *= (1.0f - defense / 100.0f);
    }

    // --- Boss melee damage + poison ---
    extern bool g_isPoisonTick;
    if (!g_isPoisonTick && g_bossDamageActive) {
        if (g_bossDamageMultiplier != 1.0f)
            damage *= g_bossDamageMultiplier;
        PoisonPlayer(uid);
    }

    Orig_SufferDamage(self, _cmd, damage, isSimulation, recoil);

    // --- PvP death detection ---
    float health = *(float *)((char *)self + 0x70);
    if (health <= 0.0f) {
        unsigned long long attackerUid = GetLastAttacker(uid);
        if (attackerUid != 0) {
            fprintf(stderr, "[PvP] Kill detected: attacker=%llu killed victim=%llu\n",
                    attackerUid, uid);

        }
    }
}

// =============================================================================
// Hook 2: NPC::hitWithForce:blockhead: — buff damage vs NPCs
// =============================================================================
typedef void (*HitWithForceFunc)(id, SEL, int, id);
static HitWithForceFunc Orig_NPC_HitWithForce = NULL;

static void Hook_NPC_HitWithForce(id self, SEL _cmd, int force, id attackerBlockhead) {
    if (attackerBlockhead) {
        unsigned long long uid = *(unsigned long long *)((char *)attackerBlockhead + UNIQUEID_OFFSET);
        float buff = GetBuff(uid);
        if (buff > 0.0f) {
            force = (int)(force * buff);
        }
    }
    Orig_NPC_HitWithForce(self, _cmd, force, attackerBlockhead);
}

// =============================================================================
// Hook 3: Blockhead::hitWithForce:blockhead: — buff damage PvP + attacker tracking
// =============================================================================
static HitWithForceFunc Orig_BH_HitWithForce = NULL;

static void Hook_BH_HitWithForce(id self, SEL _cmd, int force, id attackerBlockhead) {
    if (attackerBlockhead) {
        unsigned long long attackerUid = *(unsigned long long *)((char *)attackerBlockhead + UNIQUEID_OFFSET);
        unsigned long long victimUid = *(unsigned long long *)((char *)self + UNIQUEID_OFFSET);

        // Track last attacker for PvP kill detection
        SetLastAttacker(victimUid, attackerUid);

        // Apply buff multiplier
        float buff = GetBuff(attackerUid);
        if (buff > 0.0f) {
            force = (int)(force * buff);
        }
    }
    Orig_BH_HitWithForce(self, _cmd, force, attackerBlockhead);
}

// =============================================================================
// Init
// =============================================================================
void InitGodModeHooks(void) {

    Class bhClass = objc_getClass("Blockhead");
    Class npcClass = objc_getClass("NPC");

    if (bhClass) {
        // sufferDamage hook (defense + boss damage + death detection)
        SEL sel = sel_registerName("sufferDamage:isSimulation:recoil:");
        Method m = class_getInstanceMethod(bhClass, sel);
        if (m) {
            Orig_SufferDamage = (SufferDamageFunc)method_getImplementation(m);
            method_setImplementation(m, (IMP)Hook_SufferDamage);
            fprintf(stderr, "[Combat] sufferDamage: hooked.\n");
        }

        // Blockhead hitWithForce (PvP buff + attacker tracking)
        SEL hitSel = sel_registerName("hitWithForce:blockhead:");
        Method hm = class_getInstanceMethod(bhClass, hitSel);
        if (hm) {
            Orig_BH_HitWithForce = (HitWithForceFunc)method_getImplementation(hm);
            method_setImplementation(hm, (IMP)Hook_BH_HitWithForce);
            fprintf(stderr, "[Combat] Blockhead hitWithForce: hooked.\n");
        }
    }

    if (npcClass) {
        // NPC hitWithForce (PvE buff)
        SEL hitSel = sel_registerName("hitWithForce:blockhead:");
        Method m = class_getInstanceMethod(npcClass, hitSel);
        if (m) {
            Orig_NPC_HitWithForce = (HitWithForceFunc)method_getImplementation(m);
            method_setImplementation(m, (IMP)Hook_NPC_HitWithForce);
            fprintf(stderr, "[Combat] NPC hitWithForce: hooked.\n");
        }
    }

    fprintf(stderr, "[Combat] Buff/Defense system initialized.\n");
}
