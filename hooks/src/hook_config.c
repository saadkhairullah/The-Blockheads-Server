#include "hook_config.h"
#include "../lib/cJSON.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// Default config path (same file the TypeScript bot reads).
// MUST be set via BH_CONFIG_PATH env var in production.
// Fallback is only used if env var is not set.
#define DEFAULT_CONFIG_PATH "/etc/blockheads/config.json"

static HookConfig g_config;
static bool g_loaded = false;

// --- Helpers: read JSON with env override ---

static float getFloat(cJSON *obj, const char *key, const char *envKey, float def) {
    if (envKey) {
        const char *env = getenv(envKey);
        if (env) { float v = (float)atof(env); if (v != 0.0f || strcmp(env, "0") == 0) return v; }
    }
    cJSON *item = obj ? cJSON_GetObjectItemCaseSensitive(obj, key) : NULL;
    if (item && cJSON_IsNumber(item)) return (float)item->valuedouble;
    return def;
}

static int getInt(cJSON *obj, const char *key, const char *envKey, int def) {
    if (envKey) {
        const char *env = getenv(envKey);
        if (env) { int v = atoi(env); if (v != 0 || strcmp(env, "0") == 0) return v; }
    }
    cJSON *item = obj ? cJSON_GetObjectItemCaseSensitive(obj, key) : NULL;
    if (item && cJSON_IsNumber(item)) return item->valueint;
    return def;
}

static bool getBool(cJSON *obj, const char *key, const char *envKey, bool def) {
    if (envKey) {
        const char *env = getenv(envKey);
        if (env) return atoi(env) != 0;
    }
    cJSON *item = obj ? cJSON_GetObjectItemCaseSensitive(obj, key) : NULL;
    if (item && cJSON_IsBool(item)) return cJSON_IsTrue(item);
    return def;
}

const HookConfig* LoadHookConfig(const char *configPath) {
    if (!configPath) {
        configPath = getenv("BH_CONFIG_PATH");
        if (!configPath) configPath = DEFAULT_CONFIG_PATH;
    }

    // Read file
    FILE *f = fopen(configPath, "r");
    if (!f) {
        fprintf(stderr, "[Config] Cannot open %s — using defaults + env vars\n", configPath);
        // Fall through with NULL JSON, env vars and defaults still apply
    }

    char *json_str = NULL;
    cJSON *root = NULL;
    cJSON *hooks = NULL;

    if (f) {
        fseek(f, 0, SEEK_END);
        long len = ftell(f);
        fseek(f, 0, SEEK_SET);
        if (len > 0 && len < 1024 * 1024) {  // 1MB max
            json_str = malloc(len + 1);
            if (json_str) {
                size_t read = fread(json_str, 1, len, f);
                json_str[read] = '\0';
                root = cJSON_Parse(json_str);
                if (!root) {
                    fprintf(stderr, "[Config] JSON parse error in %s\n", configPath);
                }
            }
        }
        fclose(f);
    }

    if (root) hooks = cJSON_GetObjectItemCaseSensitive(root, "hooks");

    cJSON *boss = hooks ? cJSON_GetObjectItemCaseSensitive(hooks, "boss") : NULL;
    cJSON *bossLoot = boss ? cJSON_GetObjectItemCaseSensitive(boss, "loot") : NULL;
    cJSON *bossProj = boss ? cJSON_GetObjectItemCaseSensitive(boss, "projectile") : NULL;
    cJSON *bossTp = boss ? cJSON_GetObjectItemCaseSensitive(boss, "teleport") : NULL;
    cJSON *poison = hooks ? cJSON_GetObjectItemCaseSensitive(hooks, "poison") : NULL;
    cJSON *duel = hooks ? cJSON_GetObjectItemCaseSensitive(hooks, "duel") : NULL;
    cJSON *arena = hooks ? cJSON_GetObjectItemCaseSensitive(hooks, "arena") : NULL;
    cJSON *bossArena = hooks ? cJSON_GetObjectItemCaseSensitive(hooks, "bossArena") : NULL;

    // Boss
    g_config.bossHp              = getInt(boss, "hp", "BH_BOSS_HP", 2048);
    g_config.bossDamage          = getFloat(boss, "damage", "BH_BOSS_DAMAGE", 1.0f);
    g_config.bossSpeed           = getFloat(boss, "speed", "BH_TROLL_SPEED", 1.0f);
    g_config.bossTimer           = getFloat(boss, "timer", "BH_TROLL_TIMER", 0.0f);
    g_config.bossAggro           = getInt(boss, "aggro", "BH_TROLL_AGGRO", 16);
    g_config.bossAggroRidden     = getInt(boss, "aggroRidden", "BH_TROLL_AGGRO_RIDDEN", 3);
    g_config.bossFlight          = getBool(boss, "flight", "BH_TROLL_FLY", false);
    g_config.bossLootId          = getInt(bossLoot, "itemId", "BH_BOSS_LOOT_ID", 88);
    g_config.bossLootCount       = getInt(bossLoot, "count", "BH_BOSS_LOOT_COUNT", 10);
    g_config.bossProjectile      = getBool(bossProj, "enabled", "BH_TROLL_PROJECTILE", false);
    g_config.bossProjectileRate  = getInt(bossProj, "rate", "BH_TROLL_PROJECTILE_RATE", 3);
    g_config.bossProjectileType  = getInt(bossProj, "type", "BH_TROLL_PROJECTILE_TYPE", 0xFF);
    g_config.bossProjectileDamage = getFloat(bossProj, "damage", "BH_TROLL_PROJECTILE_DAMAGE", 10.0f);
    g_config.bossTeleport        = getBool(bossTp, "enabled", "BH_TROLL_TELEPORT", false);
    g_config.bossTeleportRate    = getInt(bossTp, "rate", "BH_TROLL_TELEPORT_RATE", 5);
    g_config.bossTeleportRange   = getInt(bossTp, "range", "BH_TROLL_TELEPORT_RANGE", 3);
    g_config.bossTeleportMaxDist = getInt(bossTp, "maxDist", "BH_TROLL_TELEPORT_MAX_DIST", 16);

    // Poison
    g_config.poisonDamage  = getFloat(poison, "damage", "BH_POISON_DAMAGE", 0.01f);
    g_config.poisonTicks   = getInt(poison, "ticks", "BH_POISON_TICKS", 20);

    // Duel
    g_config.duelCountdown      = getFloat(duel, "countdown", NULL, 10.0f);
    g_config.duelTimeout        = getFloat(duel, "timeout", NULL, 120.0f);
    g_config.duelPendingTimeout = getFloat(duel, "pendingTimeout", NULL, 60.0f);
    cJSON *duelArena = duel ? cJSON_GetObjectItemCaseSensitive(duel, "arena") : NULL;
    g_config.duelArenaX = getInt(duelArena, "x", NULL, 0);
    g_config.duelArenaY = getInt(duelArena, "y", NULL, 0);

    // Arena
    g_config.arenaWaveDelay = getFloat(arena, "waveDelay", NULL, 10.0f);
    g_config.arenaMaxWaves  = getInt(arena, "maxWaves", NULL, 10);
    g_config.arenaLootId    = getInt(arena, "lootId", NULL, 88);
    g_config.arenaLootCount = getInt(arena, "lootCount", NULL, 20);
    g_config.arenaMobCountBase      = getInt(arena, "mobCountBase", NULL, 2);
    g_config.arenaRewardPerWave     = getBool(arena, "rewardPerWave", NULL, false);
    g_config.arenaPerWaveRewardId   = getInt(arena, "perWaveRewardId", NULL, 88);
    g_config.arenaPerWaveRewardCount = getInt(arena, "perWaveRewardCount", NULL, 5);
    cJSON *arenaZone = arena ? cJSON_GetObjectItemCaseSensitive(arena, "zone") : NULL;
    g_config.arenaZoneX1 = getInt(arenaZone, "x1", NULL, 0);
    g_config.arenaZoneY1 = getInt(arenaZone, "y1", NULL, 0);
    g_config.arenaZoneX2 = getInt(arenaZone, "x2", NULL, 0);
    g_config.arenaZoneY2 = getInt(arenaZone, "y2", NULL, 0);

    // Arena per-wave mob config
    g_config.arenaWaveConfigCount = 0;
    cJSON *waves = arena ? cJSON_GetObjectItemCaseSensitive(arena, "waves") : NULL;
    if (waves && cJSON_IsArray(waves)) {
        int n = cJSON_GetArraySize(waves);
        if (n > MAX_WAVE_CONFIGS) n = MAX_WAVE_CONFIGS;
        for (int i = 0; i < n; i++) {
            cJSON *w = cJSON_GetArrayItem(waves, i);
            g_config.arenaWaves[i].mobType = getInt(w, "mobType", NULL, 6);
            g_config.arenaWaves[i].count   = getInt(w, "count", NULL, 0);
        }
        g_config.arenaWaveConfigCount = n;
    }

    // Boss arena zone
    g_config.bossArenaX1        = getInt(bossArena, "x1", "BH_BOSS_ARENA_X1", 0);
    g_config.bossArenaY1        = getInt(bossArena, "y1", "BH_BOSS_ARENA_Y1", 0);
    g_config.bossArenaX2        = getInt(bossArena, "x2", "BH_BOSS_ARENA_X2", 0);
    g_config.bossArenaY2        = getInt(bossArena, "y2", "BH_BOSS_ARENA_Y2", 0);
    g_config.bossArenaAutoBuff  = getBool(bossArena, "autoBuff", NULL, true);
    g_config.bossArenaLootScale = getBool(bossArena, "lootScale", NULL, true);
    g_config.bossArenaBuffValue = getFloat(bossArena, "buffValue", NULL, 5.0f);

    // Global troll AI config
    g_config.trollAIMaxWait = getFloat(hooks, "trollAIMaxWait", NULL, 3.0f);

    // Per-hook enable flags (default true for backwards compatibility)
    g_config.enableBoss    = getBool(boss,   "enabled", NULL, true);
    g_config.enablePoison  = getBool(poison, "enabled", NULL, true);
    g_config.enableTrade   = hooks ? getBool(cJSON_GetObjectItemCaseSensitive(hooks, "trade"), "enabled", NULL, true) : true;
    g_config.enableDuel    = getBool(duel,   "enabled", NULL, true);
    g_config.enableArena   = getBool(arena,  "enabled", NULL, true);
    g_config.enableClaims  = hooks ? getBool(cJSON_GetObjectItemCaseSensitive(hooks, "claims"), "enabled", NULL, true) : true;
    g_config.enableGodmode = hooks ? getBool(cJSON_GetObjectItemCaseSensitive(hooks, "godmode"), "enabled", NULL, true) : true;
    g_config.enableNetwork = hooks ? getBool(cJSON_GetObjectItemCaseSensitive(hooks, "network"), "enabled", NULL, true) : true;

    if (root) cJSON_Delete(root);
    free(json_str);

    g_loaded = true;

    fprintf(stderr, "[Config] Loaded from %s\n", configPath);
    fprintf(stderr, "[Config] Boss: hp=%d dmg=%.1f spd=%.1f proj=%s tp=%s fly=%s\n",
            g_config.bossHp, g_config.bossDamage, g_config.bossSpeed,
            g_config.bossProjectile ? "on" : "off",
            g_config.bossTeleport ? "on" : "off",
            g_config.bossFlight ? "on" : "off");
    fprintf(stderr, "[Config] Poison: %.3f/tick x%d\n",
            g_config.poisonDamage, g_config.poisonTicks);
    fprintf(stderr, "[Config] Hooks: boss=%s poison=%s trade=%s duel=%s arena=%s claims=%s godmode=%s network=%s\n",
            g_config.enableBoss ? "on" : "off", g_config.enablePoison ? "on" : "off",
            g_config.enableTrade ? "on" : "off",
            g_config.enableDuel ? "on" : "off", g_config.enableArena ? "on" : "off",
            g_config.enableClaims ? "on" : "off", g_config.enableGodmode ? "on" : "off",
            g_config.enableNetwork ? "on" : "off");

    return &g_config;
}

void SaveArenaZone(int x1, int y1, int x2, int y2) {
    const char *path = getenv("BH_CONFIG_PATH");
    if (!path) path = DEFAULT_CONFIG_PATH;

    FILE *f = fopen(path, "r");
    if (!f) return;
    fseek(f, 0, SEEK_END);
    long len = ftell(f);
    fseek(f, 0, SEEK_SET);
    if (len <= 0 || len > 1024 * 1024) { fclose(f); return; }
    char *json_str = malloc(len + 1);
    if (!json_str) { fclose(f); return; }
    size_t rd = fread(json_str, 1, len, f);
    json_str[rd] = '\0';
    fclose(f);

    cJSON *root = cJSON_Parse(json_str);
    free(json_str);
    if (!root) return;

    cJSON *hooks = cJSON_GetObjectItemCaseSensitive(root, "hooks");
    if (!hooks) { cJSON_Delete(root); return; }
    cJSON *arena = cJSON_GetObjectItemCaseSensitive(hooks, "arena");
    if (!arena) { cJSON_Delete(root); return; }

    // Update or create "zone" object
    cJSON *zone = cJSON_GetObjectItemCaseSensitive(arena, "zone");
    if (zone) {
        cJSON_DeleteItemFromObjectCaseSensitive(arena, "zone");
    }
    zone = cJSON_CreateObject();
    cJSON_AddNumberToObject(zone, "x1", x1);
    cJSON_AddNumberToObject(zone, "y1", y1);
    cJSON_AddNumberToObject(zone, "x2", x2);
    cJSON_AddNumberToObject(zone, "y2", y2);
    cJSON_AddItemToObject(arena, "zone", zone);

    char *out = cJSON_Print(root);
    cJSON_Delete(root);
    if (!out) return;

    f = fopen(path, "w");
    if (f) {
        fputs(out, f);
        fclose(f);
        fprintf(stderr, "[Arena] Zone saved to config: (%d,%d)-(%d,%d)\n", x1, y1, x2, y2);
    } else {
        fprintf(stderr, "[Arena] ERROR: Failed to write config at %s\n", path);
    }
    free(out);
}

const HookConfig* GetHookConfig(void) {
    return g_loaded ? &g_config : NULL;
}
