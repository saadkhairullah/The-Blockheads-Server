#include "bh_common.h"
#include "detour.h"
#include "objc_helpers.h"
#include "poison.h"
#include "hook_config.h"
#include "hook_godmode.h"
#include "hook_arena.h"

// =============================================================================
// CaveTroll struct layout (from DWARF/Ghidra RE, total 1280 bytes):
//
// DynamicObject base (80 bytes):
//   +0x08  World *world
//   +0x10  DynamicWorld *dynamicWorld
//   +0x20  intpair pos          (integer tile position)
//   +0x28  vec2 floatPos        (float render position)
//   +0x48  BOOL needsRemoved
//   +0x49  BOOL updateNeedsToBeSent
//
// NPC fields (280 bytes):
//   +0x4E  uint16_t damage      (damage dealt per hit)
//   +0x50  BOOL dead
//   +0x80  NSString *name       (128)
//   +0x98  NSString *tamedClientID (152)
//
// CaveTroll-specific fields:
//   +0x1A8  NSMutableArray *path        (424)
//   +0x1B0  float travelSpeed           (432)
//   +0x1C4  intpair fromSquare          (452)  — AI lerp start
//   +0x1CC  intpair toSquare            (460)  — AI lerp end
//   +0x1D4  intpair finalGoalSquare     (468)  — path destination
//   +0x1DC  intpair defendSquare        (476)
//   +0x208  id target/tappedNPC         (520)  — attack target
//   +0x21C  float travelFraction        (540)  — 0.0→1.0 lerp progress
//   +0x224  BOOL pathNeedsRecalculated  (548)
//   +0x22C  float randomAIWait
//   +0x41C  float cooldown
//
// Boss trolls: spawned with /spawn-boss, name field set to "BOSS".
// Only boss trolls get speed boost, teleport, projectiles, timer clamp,
// removal protection, flight, boosted HP, and boosted damage.
// Normal trolls behave vanilla.
// =============================================================================

#define BOSS_NAME "BOSS"

// --- Boss Arena zone config ---
static int g_bossArenaX1 = 0, g_bossArenaY1 = 0;
static int g_bossArenaX2 = 0, g_bossArenaY2 = 0;
static bool g_bossArenaEnabled = false;
static bool g_bossArenaAutoBuff = true;
static bool g_bossArenaLootScale = true;
static float g_bossArenaBuffValue = 5.0f;
static float g_trollAIMaxWait = 3.0f;

// Auto-buff tracking: UIDs that were auto-buffed by boss arena entry
#define MAX_AUTO_BUFFED 32
static unsigned long long g_autoBuffed[MAX_AUTO_BUFFED];
static int g_autoBuffCount = 0;

static bool IsAutoBuffed(unsigned long long uid) {
    for (int i = 0; i < g_autoBuffCount; i++) {
        if (g_autoBuffed[i] == uid) return true;
    }
    return false;
}

static void AddAutoBuffed(unsigned long long uid) {
    if (IsAutoBuffed(uid)) return;
    if (g_autoBuffCount >= MAX_AUTO_BUFFED) return;
    g_autoBuffed[g_autoBuffCount++] = uid;
}

static void RemoveAutoBuffed(unsigned long long uid) {
    for (int i = 0; i < g_autoBuffCount; i++) {
        if (g_autoBuffed[i] == uid) {
            g_autoBuffed[i] = g_autoBuffed[--g_autoBuffCount];
            return;
        }
    }
}

static bool IsInBossArena(int x, int y) {
    if (!g_bossArenaEnabled) return false;
    return x >= g_bossArenaX1 && x <= g_bossArenaX2 &&
           y >= g_bossArenaY1 && y <= g_bossArenaY2;
}

// Check if a CaveTroll is a boss (name == "BOSS")
static bool IsBoss(id self) {
    id name = *(id *)((char *)self + 0x80);
    if (!name) return false;
    SEL utf8Sel = sel_registerName("UTF8String");
    IMP imp = objc_msg_lookup(name, utf8Sel);
    if (!imp) return false;
    const char *cstr = ((const char *(*)(id, SEL))imp)(name, utf8Sel);
    return cstr && strcmp(cstr, BOSS_NAME) == 0;
}

// --- CaveTroll macro tile removal fix (BOSS ONLY) ---
static UpdatePositionFunc Orig_DynObj_UpdatePosition = NULL;

static void Hook_CaveTroll_UpdatePosition(id self, SEL _cmd, long long newPos) {
    char wasFlagged = *(char *)((char *)self + 0x48);
    Orig_DynObj_UpdatePosition(self, _cmd, newPos);
    if (!wasFlagged && *(char *)((char *)self + 0x48) && !*(char *)((char *)self + 0x50)) {
        if (IsBoss(self)) {
            *(char *)((char *)self + 0x48) = 0;
        }
    }
}

// --- CaveTroll fall damage disable (global binary patch) ---
static void PatchCaveTrollFallDamage(void) {
    unsigned char *jbe = (unsigned char *)0x008743c5;
    if (jbe[0] != 0x0f || jbe[1] != 0x86 || jbe[2] != 0x6f) {
        fprintf(stderr, "[CaveTroll] Fall damage bytes mismatch — skipping\n");
        return;
    }
    unsigned char patch[] = { 0xe9, 0x70, 0x00, 0x00, 0x00, 0x90 };
    if (patch_bytes(jbe, patch, 6)) {
        fprintf(stderr, "[CaveTroll] Fall damage disabled.\n");
    }
}

// --- Hook CaveTroll updatePosition: via ObjC method override ---
static void HookCaveTrollUpdatePosition(void) {
    Class ctClass = objc_getClass("CaveTroll");
    Class dynObjClass = objc_getClass("DynamicObject");
    if (!ctClass || !dynObjClass) return;

    SEL updatePosSel = sel_registerName("updatePosition:");
    Method m = class_getInstanceMethod(dynObjClass, updatePosSel);
    if (!m) return;

    Orig_DynObj_UpdatePosition = (UpdatePositionFunc)method_getImplementation(m);
    class_addMethod(ctClass, updatePosSel, (IMP)Hook_CaveTroll_UpdatePosition, "v@:q");
    fprintf(stderr, "[CaveTroll] updatePosition: hooked (boss-only removal protection).\n");
}

// --- CaveTroll aggro range patch (global binary patch) ---
#define ADDR_AGGRO_DEFAULT_IMM  ((unsigned char *)0x00877831)
#define ADDR_AGGRO_RIDDEN_IMM   ((unsigned char *)0x0087784d)

static void PatchCaveTrollAggro(void) {
    const HookConfig *cfg = GetHookConfig();
    if (!cfg) return;

    int aggro = cfg->bossAggro;
    if (aggro > 0 && aggro != 16) {
        unsigned char val[4] = {
            aggro & 0xff, (aggro >> 8) & 0xff,
            (aggro >> 16) & 0xff, (aggro >> 24) & 0xff
        };
        if (*ADDR_AGGRO_DEFAULT_IMM == 0x10) {
            if (patch_bytes(ADDR_AGGRO_DEFAULT_IMM, val, 4))
                fprintf(stderr, "[CaveTroll] Aggro range: 16 -> %d tiles.\n", aggro);
        }
    }

    int ridden = cfg->bossAggroRidden;
    if (ridden > 0 && ridden != 3) {
        unsigned char val[4] = {
            ridden & 0xff, (ridden >> 8) & 0xff,
            (ridden >> 16) & 0xff, (ridden >> 24) & 0xff
        };
        if (*ADDR_AGGRO_RIDDEN_IMM == 0x03)
            if (patch_bytes(ADDR_AGGRO_RIDDEN_IMM, val, 4))
                fprintf(stderr, "[CaveTroll] Ridden aggro range: 3 -> %d tiles.\n", ridden);
    }
}

// --- Boss maxHealth hook ---
// CaveTroll::maxHealth at 0x889ad0 returns 256 (0x100).
// Hook to return configurable value for bosses.
typedef int (*MaxHealthFunc)(id, SEL);
static MaxHealthFunc Orig_MaxHealth = NULL;
static int g_bossMaxHealth = 2048;

static int Hook_MaxHealth(id self, SEL _cmd) {
    if (IsBoss(self)) return g_bossMaxHealth;
    return Orig_MaxHealth(self, _cmd);
}

static void HookBossMaxHealth(void) {
    const HookConfig *cfg = GetHookConfig();
    if (cfg && cfg->bossHp > 0) g_bossMaxHealth = cfg->bossHp;

    Class ctClass = objc_getClass("CaveTroll");
    if (!ctClass) return;

    Method m = class_getInstanceMethod(ctClass, sel_registerName("maxHealth"));
    if (!m) {
        fprintf(stderr, "[CaveTroll] maxHealth not found.\n");
        return;
    }

    Orig_MaxHealth = (MaxHealthFunc)method_getImplementation(m);
    method_setImplementation(m, (IMP)Hook_MaxHealth);
    fprintf(stderr, "[CaveTroll] maxHealth hooked (boss=%d, normal=256).\n", g_bossMaxHealth);
}

// --- Boss death loot ---
// Hook CaveTroll::die: at 0x008702b0 to award loot when boss dies.
// Signature: void die:(Blockhead *)killBlockhead
typedef void (*DieFunc)(id, SEL, id);
static DieFunc Orig_CaveTroll_Die = NULL;

static void Hook_CaveTroll_Die(id self, SEL _cmd, id killBlockhead) {
    // Notify arena system of NPC death
    unsigned long long npcUid = *(unsigned long long *)((char *)self + 0x40);
    OnArenaNpcDeath(npcUid);

    bool boss = IsBoss(self);

    if (boss) {
        fprintf(stderr, "[Boss] Boss troll killed!\n");

        id dynWorld = *(id *)((char *)self + 0x10);
        if (dynWorld) {
            const HookConfig *cfg = GetHookConfig();
            int lootId = cfg ? cfg->bossLootId : 88;
            int lootCount = cfg ? cfg->bossLootCount : 10;
            extern void SpawnItem(id dynWorld, id blockhead, int itemId, int count);

            if (g_bossArenaEnabled && g_bossArenaLootScale) {
                // Scale loot: give each player in zone their share
                Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
                if (iv) {
                    id list = *(id *)((char *)dynWorld + ivar_getOffset(iv));
                    if (list) {
                        SEL sCnt = sel_registerName("count");
                        SEL sIdx = sel_registerName("objectAtIndex:");
                        int count = ((int (*)(id, SEL))objc_msg_lookup(list, sCnt))(list, sCnt);
                        int playersInZone = 0;

                        // First pass: count players in zone
                        for (int i = 0; i < count; i++) {
                            id bh = ((id (*)(id, SEL, int))objc_msg_lookup(list, sIdx))(list, sIdx, i);
                            if (!bh) continue;
                            int px = *(int *)((char *)bh + 0x20);
                            int py = *(int *)((char *)bh + 0x24);
                            if (IsInBossArena(px, py)) playersInZone++;
                        }

                        if (playersInZone > 0) {
                            // Second pass: give loot to each player in zone
                            for (int i = 0; i < count; i++) {
                                id bh = ((id (*)(id, SEL, int))objc_msg_lookup(list, sIdx))(list, sIdx, i);
                                if (!bh) continue;
                                int px = *(int *)((char *)bh + 0x20);
                                int py = *(int *)((char *)bh + 0x24);
                                if (IsInBossArena(px, py)) {
                                    SpawnItem(dynWorld, bh, lootId, lootCount);
                                }
                            }
                            fprintf(stderr, "[Boss] Loot: %d players in zone, %dx item %d each.\n",
                                    playersInZone, lootCount, lootId);
                        } else if (killBlockhead) {
                            // No players in zone, fallback to killer
                            SpawnItem(dynWorld, killBlockhead, lootId, lootCount);
                            fprintf(stderr, "[Boss] Dropped %dx item %d for killer.\n", lootCount, lootId);
                        }
                    }
                }
            } else if (killBlockhead) {
                // No boss arena, award to killer only
                SpawnItem(dynWorld, killBlockhead, lootId, lootCount);
                fprintf(stderr, "[Boss] Dropped %dx item %d for killer.\n", lootCount, lootId);
            }

            // Clean up auto-buffs on boss death
            if (g_bossArenaEnabled && g_bossArenaAutoBuff) {
                // SetBuff declared in hook_godmode.h
                for (int i = g_autoBuffCount - 1; i >= 0; i--) {
                    SetBuff(g_autoBuffed[i], 0.0f);
                }
                g_autoBuffCount = 0;
            }
        }

        fprintf(stderr, "[Boss] Boss defeated! Loot awarded.\n");

        // Emit kill event for bot to award tokens
        if (killBlockhead) {
            unsigned long long killerUid = *(unsigned long long *)((char *)killBlockhead + 0x40);
            const char *dataDir = getenv("BH_DATA_DIR");
            if (!dataDir) dataDir = "/var/lib/blockheads";
            char killLogPath[512];
            snprintf(killLogPath, sizeof(killLogPath), "%s/boss-kills.jsonl", dataDir);
            FILE *f = fopen(killLogPath, "a");
            if (f) {
                fprintf(f, "{\"blockheadId\":%llu}\n", killerUid);
                fclose(f);
            }
        }
    }

    Orig_CaveTroll_Die(self, _cmd, killBlockhead);

    // Force removal from chunk save data so boss doesn't respawn on chunk reload
    if (boss) {
        *(char *)((char *)self + 0x48) = 1;  // needsRemoved
    }
}

static void HookBossDeath(void) {
    Class ctClass = objc_getClass("CaveTroll");
    if (!ctClass) return;

    Method m = class_getInstanceMethod(ctClass, sel_registerName("die:"));
    if (!m) {
        fprintf(stderr, "[CaveTroll] die: not found.\n");
        return;
    }

    Orig_CaveTroll_Die = (DieFunc)method_getImplementation(m);
    method_setImplementation(m, (IMP)Hook_CaveTroll_Die);
    fprintf(stderr, "[CaveTroll] die: hooked (boss loot).\n");
}

// --- CaveTroll update hook (BOSS ONLY for all special behavior) ---
typedef struct { float x, y; } vec2;
typedef void (*CaveTrollUpdateFunc)(id, SEL, float, float, char);
typedef void (*FireProjectileFunc)(id, SEL, vec2, vec2, id, unsigned short, id);

static CaveTrollUpdateFunc Orig_CaveTroll_Update = NULL;
static SEL g_fireProjectileSel = NULL;
static bool g_projectilesEnabled = false;
static float g_maxTimer = 0.0f;
static int g_fireEveryNTicks = 3;
static int g_tickCounter = 0;
static unsigned short g_projectileType = 0xFF;  // default: scorpion venom (255)
static float g_trollSpeedMult = 1.0f;
static float *g_speedNumerator = NULL;
static float g_bossDamageMult = 1.0f;  // multiplier for boss attack damage
static bool g_teleportEnabled = false;
static int g_teleportEveryNTicks = 5;
static int g_teleportCounter = 0;
static int g_teleportRange = 3;
static int g_teleportMaxDist = 16;

// Boss damage flag — accessed by hook_godmode.c's sufferDamage hook
extern float g_bossDamageMultiplier;
extern bool g_bossDamageActive;

static void Hook_CaveTroll_Update(id self, SEL _cmd, float dt, float accurateDT,
                                  char isSimulation) {
    bool boss = IsBoss(self);

    // Speed boost: boss only (per-call swap)
    float savedSpeed = 0.0f;
    if (boss && g_speedNumerator) {
        savedSpeed = *g_speedNumerator;
        *g_speedNumerator = savedSpeed * g_trollSpeedMult;
    }

    // Boss damage boost: set flag so sufferDamage hook multiplies damage
    if (boss) g_bossDamageActive = true;

    Orig_CaveTroll_Update(self, _cmd, dt, accurateDT, isSimulation);

    if (boss) g_bossDamageActive = false;

    if (boss && g_speedNumerator) {
        *g_speedNumerator = savedSpeed;
    }

    if (isSimulation) return;

    // Poison DOT is now handled by hook_tick.c (DynamicWorld tick dispatcher)

    // Clamp AI timer for ALL trolls to prevent idle lock (5-15s default is too slow)
    // Safety: skip dead or pending-removal trolls to avoid writing to stale memory
    if (g_trollAIMaxWait > 0.0f &&
        !*(char *)((char *)self + 0x50) &&   // not dead
        !*(char *)((char *)self + 0x48)) {   // not needsRemoved
        float *aiWait  = (float *)((char *)self + 0x22c);
        float *cooldown = (float *)((char *)self + 0x41c);
        if (*aiWait > g_trollAIMaxWait)  *aiWait  = g_trollAIMaxWait;
        if (*cooldown > g_trollAIMaxWait) *cooldown = g_trollAIMaxWait;
    }

    if (!boss) return;

    // --- Boss Arena: auto-buff players in zone ---
    if (g_bossArenaEnabled && g_bossArenaAutoBuff) {
        id dynWorld = *(id *)((char *)self + 0x10);
        if (dynWorld) {
            Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
            if (iv) {
                id list = *(id *)((char *)dynWorld + ivar_getOffset(iv));
                if (list) {
                    SEL sCnt = sel_registerName("count");
                    SEL sIdx = sel_registerName("objectAtIndex:");
                    int count = ((int (*)(id, SEL))objc_msg_lookup(list, sCnt))(list, sCnt);

                    // SetBuff declared in hook_godmode.h
                    // GetBuff declared in hook_godmode.h

                    for (int i = 0; i < count; i++) {
                        id bh = ((id (*)(id, SEL, int))objc_msg_lookup(list, sIdx))(list, sIdx, i);
                        if (!bh) continue;
                        unsigned long long uid = *(unsigned long long *)((char *)bh + 0x40);
                        int px = *(int *)((char *)bh + 0x20);
                        int py = *(int *)((char *)bh + 0x24);
                        bool inZone = IsInBossArena(px, py);

                        if (inZone && !IsAutoBuffed(uid)) {
                            // Enter zone: apply auto-buff (configurable)
                            if (GetBuff(uid) <= 0.0f) {
                                SetBuff(uid, g_bossArenaBuffValue);
                            }
                            AddAutoBuffed(uid);
                        } else if (!inZone && IsAutoBuffed(uid)) {
                            // Exit zone: remove auto-buff (only if we applied it)
                            SetBuff(uid, 0.0f);
                            RemoveAutoBuffed(uid);
                        }
                    }
                }
            }
        }
    }

    // NOTE: Do NOT reset damage at +0x4E to 0 — that makes the boss unkillable.
    // Boss has 2048 HP from maxHealth hook, which is enough survivability.
    // Attack power scales with remaining HP (weaker as damaged) — intended mechanic.

    // --- Teleport toward target ---
    if (g_teleportEnabled && !*(char *)((char *)self + 0x50)) {
        if (++g_teleportCounter >= g_teleportEveryNTicks) g_teleportCounter = 0;
        id tpTarget = *(id *)((char *)self + 0x208);
        if (tpTarget && g_teleportCounter == 0) {
            int targX = *(int *)((char *)tpTarget + 0x20);
            int targY = *(int *)((char *)tpTarget + 0x24);
            int selfX = *(int *)((char *)self + 0x20);
            int selfY = *(int *)((char *)self + 0x24);

            int dist = abs(selfX - targX) + abs(selfY - targY);
            if (dist <= g_teleportMaxDist) {
                int dx = (selfX < targX) ? -g_teleportRange : g_teleportRange;
                int newX = targX + dx;
                int newY = targY;

                *(int *)((char *)self + 0x20) = newX;
                *(int *)((char *)self + 0x24) = newY;
                *(float *)((char *)self + 0x28) = (float)newX + 0.5f;
                *(float *)((char *)self + 0x2c) = (float)newY;

                *(int *)((char *)self + 0x1C4) = newX;
                *(int *)((char *)self + 0x1C8) = newY;
                *(int *)((char *)self + 0x1CC) = newX;
                *(int *)((char *)self + 0x1D0) = newY;
                *(int *)((char *)self + 0x1D4) = newX;
                *(int *)((char *)self + 0x1D8) = newY;

                *(float *)((char *)self + 0x21C) = 1.0f;

                IMP removeAll = objc_msg_lookup(
                    *(id *)((char *)self + 0x1A8),
                    sel_registerName("removeAllObjects"));
                if (removeAll)
                    removeAll(*(id *)((char *)self + 0x1A8),
                              sel_registerName("removeAllObjects"));

                *(char *)((char *)self + 0x224) = 1;
                *(char *)((char *)self + 0x48) = 0;
                *(char *)((char *)self + 0x49) = 1;
            }
        }
    }

    // --- Clamp AI timers ---
    if (g_maxTimer > 0.0f) {
        float *aiWait  = (float *)((char *)self + 0x22c);
        float *cooldown = (float *)((char *)self + 0x41c);
        if (*aiWait > g_maxTimer)  *aiWait  = g_maxTimer;
        if (*cooldown > g_maxTimer) *cooldown = g_maxTimer;
    }

    // --- Continuous projectile fire ---
    if (!g_projectilesEnabled) return;

    id target = *(id *)((char *)self + 0x208);
    if (!target) return;

    if (++g_tickCounter >= g_fireEveryNTicks) g_tickCounter = 0;
    if (g_tickCounter != 0) return;

    id world = *(id *)((char *)self + 0x08);
    if (!world) return;

    int selfX = *(int *)((char *)self + 0x20);
    int selfY = *(int *)((char *)self + 0x24);
    int targX = *(int *)((char *)target + 0x20);
    int targY = *(int *)((char *)target + 0x24);

    vec2 from = { (float)selfX + 0.5f, (float)selfY + 1.5f };
    vec2 to   = { (float)targX + 0.5f, (float)targY + 0.5f };

    IMP imp = objc_msg_lookup(world, g_fireProjectileSel);
    if (imp) {
        ((FireProjectileFunc)imp)(world, g_fireProjectileSel,
                                 from, to, target, g_projectileType, nil);
    }
}

static void HookCaveTrollUpdate(void) {
    const HookConfig *cfg = GetHookConfig();

    g_maxTimer = cfg ? cfg->bossTimer : 0.0f;
    if (g_maxTimer > 0.0f)
        fprintf(stderr, "[CaveTroll] AI timer cap: %.1fs (boss only).\n", g_maxTimer);

    g_trollAIMaxWait = cfg ? cfg->trollAIMaxWait : 3.0f;
    if (g_trollAIMaxWait > 0.0f)
        fprintf(stderr, "[CaveTroll] AI timer cap: %.1fs (all trolls).\n", g_trollAIMaxWait);

    if (cfg && cfg->bossProjectile) {
        g_fireProjectileSel = sel_registerName(
            "fireProjectileFrom:to:at:fireItemType:firer:");
        g_projectilesEnabled = true;
        g_fireEveryNTicks = cfg->bossProjectileRate;
        g_projectileType = (unsigned short)cfg->bossProjectileType;
        fprintf(stderr, "[CaveTroll] Projectile fire (every %d ticks, type=%u, boss only).\n",
                g_fireEveryNTicks, g_projectileType);
    }

    if (cfg && cfg->bossTeleport) {
        g_teleportEnabled = true;
        g_teleportEveryNTicks = cfg->bossTeleportRate;
        g_teleportRange = cfg->bossTeleportRange;
        g_teleportMaxDist = cfg->bossTeleportMaxDist;
        fprintf(stderr, "[CaveTroll] Teleport (every %d ticks, %d tiles, max %d, boss only).\n",
                g_teleportEveryNTicks, g_teleportRange, g_teleportMaxDist);
    }

    float speedMult = cfg ? cfg->bossSpeed : 1.0f;
    if (speedMult > 0.0f && speedMult != 1.0f) {
        g_trollSpeedMult = speedMult;
        g_speedNumerator = (float *)0x0092d84c;
        uintptr_t page = (uintptr_t)g_speedNumerator & ~0xFFF;
        mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC);
        fprintf(stderr, "[CaveTroll] Speed: %.1fx (boss only).\n", speedMult);
    }

    float bossDmg = cfg ? cfg->bossDamage : 1.0f;
    if (bossDmg > 0.0f) {
        g_bossDamageMult = bossDmg;
        g_bossDamageMultiplier = bossDmg;
        if (bossDmg != 1.0f)
            fprintf(stderr, "[CaveTroll] Boss damage: %.1fx (boss only).\n", bossDmg);
    }

    Class ctClass = objc_getClass("CaveTroll");
    if (!ctClass) return;

    SEL updateSel = sel_registerName("update:accurateDT:isSimulation:");
    Method m = class_getInstanceMethod(ctClass, updateSel);
    if (!m) {
        fprintf(stderr, "[CaveTroll] update:accurateDT:isSimulation: not found.\n");
        return;
    }

    Orig_CaveTroll_Update = (CaveTrollUpdateFunc)method_getImplementation(m);
    method_setImplementation(m, (IMP)Hook_CaveTroll_Update);
    fprintf(stderr, "[CaveTroll] update: hooked (boss-only enhancements).\n");
}

// --- CaveTroll flight (BOSS ONLY) ---
static BOOL (*Orig_CanFly)(id, SEL) = NULL;

static BOOL Hook_CanFly(id self, SEL _cmd) {
    if (IsBoss(self)) return 1;
    return Orig_CanFly ? Orig_CanFly(self, _cmd) : 0;
}

static void HookCaveTrollFlight(void) {
    const HookConfig *cfg = GetHookConfig();
    if (!cfg || !cfg->bossFlight) return;

    Class ctClass = objc_getClass("CaveTroll");
    if (!ctClass) return;

    Method m = class_getInstanceMethod(ctClass, sel_registerName("canFly"));
    if (!m) return;

    Orig_CanFly = (BOOL (*)(id, SEL))method_getImplementation(m);
    method_setImplementation(m, (IMP)Hook_CanFly);
    fprintf(stderr, "[CaveTroll] Flight enabled for boss trolls.\n");
}

// --- Projectile damage patch ---
// Address 0x009141a0 holds the float 10.0 used as force for poison/poison-arrow projectiles.
// Configurable via BH_TROLL_PROJECTILE_DAMAGE env var (default: 20.0 = doubled).
#define ADDR_PROJECTILE_FORCE ((float *)0x009141a0)

static void PatchProjectileDamage(void) {
    const HookConfig *cfg = GetHookConfig();
    float newForce = cfg ? cfg->bossProjectileDamage : 10.0f;
    if (newForce == 10.0f) return;  // no change needed

    uintptr_t page = (uintptr_t)ADDR_PROJECTILE_FORCE & ~0xFFF;
    if (mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        fprintf(stderr, "[CaveTroll] Projectile damage mprotect failed.\n");
        return;
    }
    float old = *ADDR_PROJECTILE_FORCE;
    *ADDR_PROJECTILE_FORCE = newForce;
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);
    fprintf(stderr, "[CaveTroll] Projectile force: %.1f -> %.1f\n", old, newForce);
}

void InitCaveTrollHooks(void) {
    PatchCaveTrollFallDamage();
    HookCaveTrollUpdatePosition();
    PatchCaveTrollAggro();
    HookBossMaxHealth();
    HookBossDeath();
    HookCaveTrollUpdate();
    HookCaveTrollFlight();
    PatchProjectileDamage();

    // --- Boss Arena zone config ---
    const HookConfig *cfg = GetHookConfig();
    if (cfg && (cfg->bossArenaX1 != 0 || cfg->bossArenaY1 != 0 ||
                cfg->bossArenaX2 != 0 || cfg->bossArenaY2 != 0)) {
        g_bossArenaX1 = cfg->bossArenaX1;
        g_bossArenaY1 = cfg->bossArenaY1;
        g_bossArenaX2 = cfg->bossArenaX2;
        g_bossArenaY2 = cfg->bossArenaY2;
        g_bossArenaAutoBuff = cfg->bossArenaAutoBuff;
        g_bossArenaLootScale = cfg->bossArenaLootScale;
        g_bossArenaBuffValue = cfg->bossArenaBuffValue;
        g_bossArenaEnabled = true;
        fprintf(stderr, "[BossArena] Zone: (%d,%d)-(%d,%d) autoBuff=%d lootScale=%d\n",
                g_bossArenaX1, g_bossArenaY1, g_bossArenaX2, g_bossArenaY2,
                g_bossArenaAutoBuff, g_bossArenaLootScale);
    }
}
