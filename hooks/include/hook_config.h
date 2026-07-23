#ifndef HOOK_CONFIG_H
#define HOOK_CONFIG_H

#include <stdbool.h>

#define MAX_WAVE_CONFIGS 20

typedef struct {
    int mobType;    // NPC type to spawn (6=cave troll, 7=scorpion, etc.)
    int count;      // Number of mobs for this wave (0 = use waveNumber * countBase)
} WaveConfig;

typedef struct {
    // Boss
    int bossHp;
    float bossDamage;
    float bossSpeed;
    float bossTimer;
    int bossAggro;
    int bossAggroRidden;
    bool bossFlight;
    int bossLootId;
    int bossLootCount;
    bool bossProjectile;
    int bossProjectileRate;
    int bossProjectileType;
    float bossProjectileDamage;
    bool bossTeleport;
    int bossTeleportRate;
    int bossTeleportRange;
    int bossTeleportMaxDist;
    // Poison
    float poisonDamage;
    int poisonTicks;
    // Duel
    float duelCountdown;
    float duelTimeout;
    float duelPendingTimeout;
    int duelArenaX;   // Fixed duel spawn X (0 = use midpoint)
    int duelArenaY;   // Fixed duel spawn Y (0 = use midpoint)
    // Arena
    float arenaWaveDelay;
    int arenaMaxWaves;
    int arenaLootId;
    int arenaLootCount;
    int arenaMobCountBase;                  // fallback: wave * base (default 2)
    WaveConfig arenaWaves[MAX_WAVE_CONFIGS];
    int arenaWaveConfigCount;               // 0 = use defaults
    bool arenaRewardPerWave;                // reward after each wave clear
    int arenaPerWaveRewardId;
    int arenaPerWaveRewardCount;
    // Mob arena zone (persistent across restarts)
    int arenaZoneX1, arenaZoneY1, arenaZoneX2, arenaZoneY2;
    // Boss arena zone
    int bossArenaX1, bossArenaY1, bossArenaX2, bossArenaY2;
    bool bossArenaAutoBuff;
    bool bossArenaLootScale;
    float bossArenaBuffValue;               // buff multiplier for players in boss arena (default 5.0)
    // Global troll AI
    float trollAIMaxWait;                   // non-boss troll AI timer clamp (default 3.0)
    // Per-hook enable flags (all default true for backwards compatibility)
    bool enableBoss;
    bool enablePoison;
    bool enableTrade;
    bool enableDuel;
    bool enableArena;
    bool enableClaims;
    bool enableGodmode;
    bool enableNetwork;
} HookConfig;

// Load config from JSON file (reads "hooks" section).
// configPath: path to config.json. If NULL, uses BH_CONFIG_PATH env or default.
// Returns pointer to global config struct.
const HookConfig* LoadHookConfig(const char *configPath);

// Get previously loaded config. Returns NULL if not yet loaded.
const HookConfig* GetHookConfig(void);
void SaveArenaZone(int x1, int y1, int x2, int y2);

#endif // HOOK_CONFIG_H
