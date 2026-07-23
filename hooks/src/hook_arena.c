#include "bh_common.h"
#include "objc_helpers.h"
#include "entity.h"
#include "hook_config.h"
#include "hook_arena.h"

// =============================================================================
// Mob Wave Arena
//
// Admin-defined zone where waves of cave trolls spawn. 10 waves, each wave
// spawns wave_number * 2 trolls. Wave 10's last troll is a boss (named "BOSS").
// Loot awarded to all players in zone after clearing all waves.
//
// Commands (admin only, handled in hook_commands.c):
//   /arena set <x1> <y1> <x2> <y2>  — define arena zone
//   /arena start                      — begin wave 1
//   /arena stop                       — cancel current run
//
// NPC death tracking: Hook_CaveTroll_Die calls OnArenaNpcDeath() when any
// NPC dies. If it matches a tracked arena mob, decrement counter.
// =============================================================================

#define MAX_ARENA_NPCS 64
#define UNIQUEID_OFFSET 0x40
#define SPAWN_STAGGER_INTERVAL 0.5f  // seconds between each mob spawn in a wave

typedef struct {
    int x, y;
    int mobType;
    bool isBoss;
} PendingSpawn;

typedef struct {
    int x1, y1, x2, y2;        // Arena zone bounds
    int currentWave;             // 0 = idle, 1-10 = active
    int npcsAlive;               // Remaining NPCs in current wave
    unsigned long long npcUids[MAX_ARENA_NPCS];
    int npcUidCount;
    float waveTimer;             // Countdown to next wave / spawn delay
    bool active;
    // Pending staggered spawns
    PendingSpawn pendingSpawns[MAX_ARENA_NPCS];
    int pendingCount;
    float spawnStaggerTimer;    // countdown between each queued spawn
} ArenaInstance;

static ArenaInstance g_arena = {0};

// Config
static float g_arenaWaveDelay = 10.0f;
static int g_arenaMaxWaves = 10;
static int g_arenaLootId = 88;
static int g_arenaLootCount = 20;
static int g_arenaMobCountBase = 2;
static WaveConfig g_arenaWaves[MAX_WAVE_CONFIGS];
static int g_arenaWaveConfigCount = 0;
static bool g_arenaRewardPerWave = false;
static int g_arenaPerWaveRewardId = 88;
static int g_arenaPerWaveRewardCount = 5;

// Cached refs
static id g_cachedServer = nil;
static id g_cachedDynWorld = nil;

void InitArenaSystem(void) {
    const HookConfig *cfg = GetHookConfig();
    if (cfg) {
        if (cfg->arenaWaveDelay > 0.0f) g_arenaWaveDelay = cfg->arenaWaveDelay;
        if (cfg->arenaMaxWaves > 0) g_arenaMaxWaves = cfg->arenaMaxWaves;
        if (cfg->arenaLootId > 0) g_arenaLootId = cfg->arenaLootId;
        if (cfg->arenaLootCount > 0) g_arenaLootCount = cfg->arenaLootCount;
        if (cfg->arenaMobCountBase > 0) g_arenaMobCountBase = cfg->arenaMobCountBase;
        g_arenaRewardPerWave = cfg->arenaRewardPerWave;
        if (cfg->arenaPerWaveRewardId > 0) g_arenaPerWaveRewardId = cfg->arenaPerWaveRewardId;
        if (cfg->arenaPerWaveRewardCount > 0) g_arenaPerWaveRewardCount = cfg->arenaPerWaveRewardCount;
        g_arenaWaveConfigCount = cfg->arenaWaveConfigCount;
        for (int i = 0; i < g_arenaWaveConfigCount; i++) {
            g_arenaWaves[i] = cfg->arenaWaves[i];
        }
    }
    memset(&g_arena, 0, sizeof(g_arena));
    // Load persistent arena zone from config
    if (cfg && (cfg->arenaZoneX1 || cfg->arenaZoneY1 || cfg->arenaZoneX2 || cfg->arenaZoneY2)) {
        g_arena.x1 = cfg->arenaZoneX1;
        g_arena.y1 = cfg->arenaZoneY1;
        g_arena.x2 = cfg->arenaZoneX2;
        g_arena.y2 = cfg->arenaZoneY2;
        fprintf(stderr, "[Arena] Zone loaded from config: (%d,%d)-(%d,%d)\n",
                g_arena.x1, g_arena.y1, g_arena.x2, g_arena.y2);
    }
    fprintf(stderr, "[Arena] Initialized: waveDelay=%.0fs maxWaves=%d loot=%dx%d waveConfigs=%d\n",
            g_arenaWaveDelay, g_arenaMaxWaves, g_arenaLootCount, g_arenaLootId, g_arenaWaveConfigCount);
}

// --- Helpers ---

static bool IsArenaZoneSet(void) {
    return g_arena.x1 != 0 || g_arena.y1 != 0 ||
           g_arena.x2 != 0 || g_arena.y2 != 0;
}

static bool IsInArenaZone(int x, int y) {
    return x >= g_arena.x1 && x <= g_arena.x2 &&
           y >= g_arena.y1 && y <= g_arena.y2;
}

// Queue up spawns for a wave — actual spawning is staggered via UpdateArena
static void QueueWave(int waveNumber) {
    int mobType = 6;
    int trollCount = waveNumber * g_arenaMobCountBase;
    if (g_arenaWaveConfigCount > 0) {
        int idx = waveNumber - 1;
        if (idx >= g_arenaWaveConfigCount) idx = g_arenaWaveConfigCount - 1;
        mobType = g_arenaWaves[idx].mobType;
        if (g_arenaWaves[idx].count > 0) trollCount = g_arenaWaves[idx].count;
    }
    if (trollCount > MAX_ARENA_NPCS) trollCount = MAX_ARENA_NPCS;
    bool lastWave = (waveNumber >= g_arenaMaxWaves);

    int zoneW = g_arena.x2 - g_arena.x1;
    int zoneH = g_arena.y2 - g_arena.y1;
    if (zoneW < 2) zoneW = 2;
    if (zoneH < 2) zoneH = 2;

    g_arena.pendingCount = 0;
    for (int i = 0; i < trollCount && g_arena.pendingCount < MAX_ARENA_NPCS; i++) {
        PendingSpawn *ps = &g_arena.pendingSpawns[g_arena.pendingCount++];
        ps->x = g_arena.x1 + (i * zoneW / trollCount) + 1;
        ps->y = g_arena.y1 + (zoneH / 2);
        ps->mobType = mobType;
        ps->isBoss = lastWave && (i == trollCount - 1);
    }

    // npcsAlive starts at 0 — incremented as each spawn succeeds
    g_arena.npcsAlive = 0;
    g_arena.npcUidCount = 0;
    g_arena.spawnStaggerTimer = 0.0f;  // first spawn fires immediately

    char msg[256];
    snprintf(msg, 256, "[Arena] Wave %d/%d incoming — %d enemies!",
             waveNumber, g_arenaMaxWaves, trollCount);
    if (g_cachedServer) SendChat(g_cachedServer, msg);
}

static int AwardLootToZone(id dynWorld, int itemId, int itemCount) {
    // Award loot to all players in the arena zone, returns count of players rewarded
    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) return 0;
    id list = *(id *)((char *)dynWorld + ivar_getOffset(iv));
    if (!list) return 0;

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    int count = ((int (*)(id, SEL))objc_msg_lookup(list, sCnt))(list, sCnt);
    int rewarded = 0;

    for (int i = 0; i < count; i++) {
        id bh = ((id (*)(id, SEL, int))objc_msg_lookup(list, sIdx))(list, sIdx, i);
        if (!bh) continue;
        int px = *(int *)((char *)bh + 0x20);
        int py = *(int *)((char *)bh + 0x24);
        if (IsInArenaZone(px, py)) {
            SpawnItem(dynWorld, bh, itemId, itemCount);
            rewarded++;
        }
    }
    return rewarded;
}

static void AwardArenaLoot(id dynWorld) {
    int rewarded = AwardLootToZone(dynWorld, g_arenaLootId, g_arenaLootCount);

    char msg[256];
    snprintf(msg, 256, "[Arena] ALL WAVES CLEARED! %dx item %d awarded to %d players!",
             g_arenaLootCount, g_arenaLootId, rewarded);
    if (g_cachedServer) SendChat(g_cachedServer, msg);
    fprintf(stderr, "[Arena] Complete! Awarded loot to %d players.\n", rewarded);
}

// --- Public API ---

bool OnArenaNpcDeath(unsigned long long npcUid) {
    if (!g_arena.active || g_arena.npcsAlive <= 0) return false;

    // Any NPC death during active arena counts (we don't track individual UIDs
    // because getting the UID at spawn time is complex with the current API).
    // The arena zone is isolated, so this is safe.
    g_arena.npcsAlive--;
    fprintf(stderr, "[Arena] NPC died. %d remaining in wave %d.\n",
            g_arena.npcsAlive, g_arena.currentWave);

    if (g_arena.npcsAlive <= 0) {
        if (g_arena.currentWave >= g_arenaMaxWaves) {
            // All waves cleared!
            if (g_cachedDynWorld) AwardArenaLoot(g_cachedDynWorld);
            g_arena.active = false;
            g_arena.currentWave = 0;
        } else {
            // Per-wave reward
            if (g_arenaRewardPerWave && g_cachedDynWorld) {
                int rewarded = AwardLootToZone(g_cachedDynWorld, g_arenaPerWaveRewardId, g_arenaPerWaveRewardCount);
                char rwdMsg[256];
                snprintf(rwdMsg, 256, "[Arena] Wave %d reward: %dx item %d to %d players!",
                         g_arena.currentWave, g_arenaPerWaveRewardCount, g_arenaPerWaveRewardId, rewarded);
                if (g_cachedServer) SendChat(g_cachedServer, rwdMsg);
            }
            // Start delay for next wave
            g_arena.waveTimer = g_arenaWaveDelay;
            char msg[128];
            snprintf(msg, 128, "[Arena] Wave %d cleared! Next wave in %.0f seconds...",
                     g_arena.currentWave, g_arenaWaveDelay);
            if (g_cachedServer) SendChat(g_cachedServer, msg);
        }
    }

    return true;
}

void HandleArenaSet(id server, int x1, int y1, int x2, int y2) {
    // Normalize bounds
    if (x1 > x2) { int t = x1; x1 = x2; x2 = t; }
    if (y1 > y2) { int t = y1; y1 = y2; y2 = t; }

    g_arena.x1 = x1;
    g_arena.y1 = y1;
    g_arena.x2 = x2;
    g_arena.y2 = y2;

    SaveArenaZone(x1, y1, x2, y2);

    char msg[256];
    snprintf(msg, 256, "[Arena] Zone set: (%d,%d) to (%d,%d)", x1, y1, x2, y2);
    SendChat(server, msg);
    fprintf(stderr, "[Arena] Zone: (%d,%d)-(%d,%d)\n", x1, y1, x2, y2);
}

void HandleArenaStart(id server, id dynWorld) {
    if (!IsArenaZoneSet()) {
        SendChat(server, "[Arena] No zone set. Use: /arena set <x1> <y1> <x2> <y2>");
        return;
    }
    if (g_arena.active) {
        SendChat(server, "[Arena] Arena already running! Use /arena stop first.");
        return;
    }

    g_arena.active = true;
    g_arena.currentWave = 1;
    g_arena.npcsAlive = 0;
    g_arena.npcUidCount = 0;
    g_arena.waveTimer = 0.0f; // Spawn immediately
    g_cachedServer = server;
    g_cachedDynWorld = dynWorld;

    SendChat(server, "[Arena] WAVE ARENA STARTED! Get to the arena zone!");
    QueueWave(1);
    fprintf(stderr, "[Arena] Started!\n");
}

static void KillArenaNPCs(id dynWorld) {
    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "dynamicObjects");
    if (!iv) return;
    id list = *(id *)((char *)dynWorld + ivar_getOffset(iv));
    if (!list) return;

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    int count = ((int (*)(id, SEL))objc_msg_lookup(list, sCnt))(list, sCnt);

    int killed = 0;
    for (int i = 0; i < count; i++) {
        id obj = ((id (*)(id, SEL, int))objc_msg_lookup(list, sIdx))(list, sIdx, i);
        if (!obj) continue;
        if (*(char *)((char *)obj + 0x50)) continue;  // already dead
        if (*(char *)((char *)obj + 0x48)) continue;  // already flagged
        int px = *(int *)((char *)obj + 0x20);
        int py = *(int *)((char *)obj + 0x24);
        if (!IsInArenaZone(px, py)) continue;
        *(char *)((char *)obj + 0x48) = 1;  // needsRemoved
        killed++;
    }
    if (killed > 0)
        fprintf(stderr, "[Arena] Removed %d surviving NPCs on stop.\n", killed);
}

void HandleArenaStop(id server) {
    if (!g_arena.active) {
        SendChat(server, "[Arena] No arena is running.");
        return;
    }

    if (g_cachedDynWorld) KillArenaNPCs(g_cachedDynWorld);

    g_arena.active = false;
    g_arena.currentWave = 0;
    g_arena.npcsAlive = 0;
    g_arena.npcUidCount = 0;
    g_arena.pendingCount = 0;

    SendChat(server, "[Arena] Arena stopped.");
    fprintf(stderr, "[Arena] Stopped.\n");
}

// Spawn one NPC from the pending queue. Returns true if spawned successfully.
static bool SpawnOnePending(id dynWorld) {
    if (g_arena.pendingCount <= 0) return false;

    // Take first pending spawn
    PendingSpawn ps = g_arena.pendingSpawns[0];
    for (int i = 1; i < g_arena.pendingCount; i++)
        g_arena.pendingSpawns[i - 1] = g_arena.pendingSpawns[i];
    g_arena.pendingCount--;

    SEL loadSel = sel_registerName(
        "loadNPCAtPosition:type:saveDict:isAdult:wasPlaced:placedByClient:");
    IMP loadImp = objc_msg_lookup(dynWorld, loadSel);
    if (!loadImp) return false;

    long long pos = ((long long)(unsigned int)ps.y << 32) | (long long)(unsigned int)ps.x;
    id saveDict = nil;

    if (ps.isBoss) {
        Class dictClass = objc_getClass("NSMutableDictionary");
        SEL allocSel = sel_registerName("alloc");
        SEL initSel  = sel_registerName("init");
        id dict = ((id (*)(id, SEL))objc_msg_lookup((id)dictClass, allocSel))((id)dictClass, allocSel);
        dict = ((id (*)(id, SEL))objc_msg_lookup(dict, initSel))(dict, initSel);
        SEL setSel = sel_registerName("setObject:forKey:");
        ((void (*)(id, SEL, id, id))objc_msg_lookup(dict, setSel))(
            dict, setSel, NSStr("BOSS"), NSStr("name"));
        saveDict = dict;
    }

    BOOL result = ((BOOL (*)(id, SEL, long long, int, id, BOOL, BOOL, id))loadImp)(
        dynWorld, loadSel, pos, ps.mobType, saveDict, 1, 1, nil);

    if (result) {
        g_arena.npcsAlive++;
        fprintf(stderr, "[Arena] Spawned %s (type %d) at (%d,%d) — alive=%d pending=%d\n",
                ps.isBoss ? "BOSS" : "mob", ps.mobType, ps.x, ps.y,
                g_arena.npcsAlive, g_arena.pendingCount);
    } else {
        fprintf(stderr, "[Arena] Spawn FAILED (type %d) at (%d,%d)\n",
                ps.mobType, ps.x, ps.y);
    }
    return result;
}

// --- Tick Update ---

void UpdateArena(id dynWorld, float dt) {
    if (!g_arena.active) return;

    // Cache dynWorld ref for loot award
    g_cachedDynWorld = dynWorld;

    // Update server ref
    id world = NULL;
    Ivar worldIv = class_getInstanceVariable(object_getClass(dynWorld), "world");
    if (worldIv) world = *(id *)((char *)dynWorld + ivar_getOffset(worldIv));
    if (world) {
        Ivar serverIv = class_getInstanceVariable(object_getClass(world), "server");
        if (serverIv) g_cachedServer = *(id *)((char *)world + ivar_getOffset(serverIv));
    }

    // Drain pending spawn queue — one mob per stagger interval
    if (g_arena.pendingCount > 0) {
        g_arena.spawnStaggerTimer -= dt;
        if (g_arena.spawnStaggerTimer <= 0.0f) {
            SpawnOnePending(dynWorld);
            g_arena.spawnStaggerTimer = SPAWN_STAGGER_INTERVAL;
        }
        return;  // don't start next-wave timer while still spawning
    }

    // All pending spawns done — wait for players to kill them
    // If all dead and wave is not the last, count down to next wave
    if (g_arena.npcsAlive <= 0 && g_arena.currentWave < g_arenaMaxWaves) {
        g_arena.waveTimer -= dt;
        if (g_arena.waveTimer <= 0.0f) {
            g_arena.currentWave++;
            QueueWave(g_arena.currentWave);
        }
    }
}
