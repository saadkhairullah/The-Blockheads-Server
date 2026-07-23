#include "bh_common.h"
#include "objc_helpers.h"
#include "poison.h"
#include "hook_config.h"

// =============================================================================
// Poison DOT System
//
// When a boss hits a player (melee), they get poisoned — taking small recurring
// damage ticks for a short duration. God mode players are immune (never added
// to poison list because sufferDamage returns early for them).
//
// Config (env vars):
//   BH_POISON_DAMAGE   — damage per tick as fraction of HP (default: 0.01 = 1%)
//   BH_POISON_TICKS    — duration in game ticks (default: 20 ≈ 1 second)
//
// Called from:
//   hook_godmode.c  — PoisonPlayer() on boss melee hit
//   hook_cavetroll.c — ProcessPoisonTicks() in boss update loop
// =============================================================================

#define MAX_POISONED 32
#define UNIQUEID_OFFSET 0x40

typedef struct {
    unsigned long long uid;
    int ticksRemaining;
} PoisonEntry;

static PoisonEntry g_poisoned[MAX_POISONED];
static int g_poisonCount = 0;
static float g_poisonDamage = 0.01f;   // 1% HP per tick
static int g_poisonDuration = 20;       // ~1 second at ~20Hz tick rate

// Flag to prevent re-poisoning during poison ticks (set by ProcessPoisonTicks,
// checked by Hook_SufferDamage in hook_godmode.c)
bool g_isPoisonTick = false;

void InitPoison(void) {
    const HookConfig *cfg = GetHookConfig();
    if (cfg) {
        if (cfg->poisonDamage > 0.0f) g_poisonDamage = cfg->poisonDamage;
        if (cfg->poisonTicks > 0) g_poisonDuration = cfg->poisonTicks;
    }
    fprintf(stderr, "[Poison] Initialized: %.3f damage/tick, %d ticks (~%.1fs)\n",
            g_poisonDamage, g_poisonDuration, g_poisonDuration / 20.0f);
}

void PoisonPlayer(unsigned long long uid) {
    // Refresh duration if already poisoned
    for (int i = 0; i < g_poisonCount; i++) {
        if (g_poisoned[i].uid == uid) {
            g_poisoned[i].ticksRemaining = g_poisonDuration;
            return;
        }
    }
    if (g_poisonCount >= MAX_POISONED) return;
    g_poisoned[g_poisonCount].uid = uid;
    g_poisoned[g_poisonCount].ticksRemaining = g_poisonDuration;
    g_poisonCount++;
    fprintf(stderr, "[Poison] Player %llu poisoned (%d ticks)\n", uid, g_poisonDuration);
}

void ProcessPoisonTicks(id dynWorld) {
    if (g_poisonCount == 0) return;

    // Get netBlockheads array
    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) return;
    id list = *(id *)((char *)dynWorld + ivar_getOffset(iv));
    if (!list) return;

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    int count = ((int (*)(id, SEL))objc_msg_lookup(list, sCnt))(list, sCnt);

    SEL sufferSel = sel_registerName("sufferDamage:isSimulation:recoil:");

    g_isPoisonTick = true;

    for (int p = g_poisonCount - 1; p >= 0; p--) {
        g_poisoned[p].ticksRemaining--;
        if (g_poisoned[p].ticksRemaining <= 0) {
            // Remove expired — swap with last
            g_poisoned[p] = g_poisoned[--g_poisonCount];
            continue;
        }

        // Find blockhead by uniqueID and deal poison damage
        for (int i = 0; i < count; i++) {
            id bh = ((id (*)(id, SEL, int))objc_msg_lookup(list, sIdx))(list, sIdx, i);
            if (!bh) continue;
            unsigned long long bhUid = *(unsigned long long *)((char *)bh + UNIQUEID_OFFSET);
            if (bhUid == g_poisoned[p].uid) {
                IMP imp = objc_msg_lookup(bh, sufferSel);
                if (imp) {
                    ((void (*)(id, SEL, float, BOOL, int))imp)(
                        bh, sufferSel, g_poisonDamage, 0, 0);
                }
                break;
            }
        }
    }

    g_isPoisonTick = false;
}
