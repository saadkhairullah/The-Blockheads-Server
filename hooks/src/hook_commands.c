#include "bh_common.h"
#include "objc_helpers.h"
#include "entity.h"
#include "admin.h"
#include "hook_config.h"
#include "hook_arena.h"
#include "hook_claims.h"
#include "hook_godmode.h"
#include <errno.h>

// Safe integer parser using strtol. Clamps result to [min, max].
// Returns false and sets *out=min on invalid/empty input.
static bool parse_int_clamped(const char *s, int min, int max, int *out) {
    if (!s || *s == '\0') { *out = min; return false; }
    char *end;
    errno = 0;
    long v = strtol(s, &end, 10);
    if (errno != 0 || end == s || *end != '\0') { *out = min; return false; }
    if (v < min) v = min;
    if (v > max) v = max;
    *out = (int)v;
    return true;
}

// World coordinate bounds — generous but prevents integer overflow in arithmetic
#define COORD_MIN (-500000)
#define COORD_MAX  500000

// --- Helper: resolve peer ID → player name via server's playerInfoForPeerID: ---
static const char* GetClientPlayerName(id server, id peerID) {
    if (!server || !peerID) return NULL;
    SEL infoSel = sel_registerName("playerInfoForPeerID:");
    id info = ((id (*)(id, SEL, id))objc_msg_lookup(server, infoSel))(server, infoSel, peerID);
    if (!info) return NULL;
    SEL keySel = sel_registerName("objectForKey:");
    id nameObj = ((id (*)(id, SEL, id))objc_msg_lookup(info, keySel))(info, keySel, NSStr("name"));
    return nameObj ? ToCStr(nameObj) : NULL;
}

// --- Helper: check if issuing client is admin ---
// Uses adminlist.txt via IsAdmin(). Resolves peer ID → name via server.
static bool IsClientAdmin(id server, id client) {
    if (client == nil) return true;  // console = always allowed
    const char *name = GetClientPlayerName(server, client);
    return IsAdmin(name);
}

// --- Helper: create NSMutableDictionary ---
static id NewDict(void) {
    Class cls = objc_getClass("NSMutableDictionary");
    SEL allocSel = sel_registerName("alloc");
    SEL initSel = sel_registerName("init");
    id dict = ((id (*)(id, SEL))objc_msg_lookup((id)cls, allocSel))((id)cls, allocSel);
    return ((id (*)(id, SEL))objc_msg_lookup(dict, initSel))(dict, initSel);
}

static void DictSet(id dict, const char *key, id value) {
    SEL setSel = sel_registerName("setObject:forKey:");
    ((void (*)(id, SEL, id, id))objc_msg_lookup(dict, setSel))(dict, setSel, value, NSStr(key));
}

// --- Helper: get world + dynWorld from server ---
static bool GetWorlds(id server, id *world, id *dynWorld) {
    *world = nil;
    *dynWorld = nil;
    object_getInstanceVariable(server, "world", (void**)world);
    if (*world) object_getInstanceVariable(*world, "dynamicWorld", (void**)dynWorld);
    return *dynWorld != nil;
}

// --- Command handler ---
id Hook_HandleCmd(id self, SEL _cmd, id cmdStr, id client) {
    const char* rawOrig = ToCStr(cmdStr);
    if (!rawOrig) return Real_HandleCmd(self, _cmd, cmdStr, client);

    // Copy to mutable buffer and strip trailing whitespace/newlines (stdin adds \n)
    static __thread char rawBuf[512];
    strncpy(rawBuf, rawOrig, 511);
    rawBuf[511] = '\0';
    int rawLen = (int)strlen(rawBuf);
    while (rawLen > 0 && (rawBuf[rawLen-1] == '\n' || rawBuf[rawLen-1] == '\r' || rawBuf[rawLen-1] == ' '))
        rawBuf[--rawLen] = '\0';
    const char *raw = rawBuf;

    fprintf(stderr, "[Cmd] raw=\"%s\"\n", raw);

    // --- /tp-native <blockheadId> <x> <y> --- (ADMIN ONLY)
    if (strncmp(raw, "/tp-native ", 11) == 0) {
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[TP] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        char buf[256];
        strncpy(buf, raw, 255); buf[255] = '\0';
        char *sp;
        strtok_r(buf, " ", &sp);
        char *idStr = strtok_r(NULL, " ", &sp);
        char *xStr  = strtok_r(NULL, " ", &sp);
        char *yStr  = strtok_r(NULL, " ", &sp);

        if (!idStr || !xStr || !yStr) {
            SendChat(self, "[TP] Usage: /tp-native <blockheadId> <x> <y>");
            DrainPool(pool);
            return nil;
        }

        unsigned long long bhId = strtoull(idStr, NULL, 10);
        int x, y;
        parse_int_clamped(xStr, COORD_MIN, COORD_MAX, &x);
        parse_int_clamped(yStr, COORD_MIN, COORD_MAX, &y);

        id blockhead = FindBlockheadById(dynWorld, bhId);
        if (!blockhead) {
            char err[128];
            snprintf(err, 128, "[TP] Blockhead %llu not found (must be online)", bhId);
            SendChat(self, err);
            DrainPool(pool);
            return nil;
        }

        int ok = TeleportBlockhead(blockhead, x, y);
        fprintf(stderr, "[TP] tp-native blockhead=%llu to (%d,%d) -> %s\n",
                bhId, x, y, ok ? "OK" : "FAILED");

        DrainPool(pool);
        return nil;
    }

    // --- /spawn-troll <x> <y> [ownerUUID] --- (ADMIN ONLY, requires enableBoss)
    if (strncmp(raw, "/spawn-troll ", 13) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableBoss) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[Spawn] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        char buf[512];
        strncpy(buf, raw, 511); buf[511] = '\0';
        char *sp;
        strtok_r(buf, " ", &sp);
        char *xStr = strtok_r(NULL, " ", &sp);
        char *yStr = strtok_r(NULL, " ", &sp);
        char *ownerUuid = strtok_r(NULL, " ", &sp);

        if (!xStr || !yStr) {
            SendChat(self, "[Spawn] Usage: /spawn-troll <x> <y> [ownerUUID]");
            DrainPool(pool);
            return nil;
        }

        int x, y;
        parse_int_clamped(xStr, COORD_MIN, COORD_MAX, &x);
        parse_int_clamped(yStr, COORD_MIN, COORD_MAX, &y);
        long long pos = ((long long)(unsigned int)y << 32) | (long long)(unsigned int)x;

        id saveDict = nil;
        id clientIdStr = nil;
        if (ownerUuid && strlen(ownerUuid) > 0) {
            char *end = ownerUuid + strlen(ownerUuid) - 1;
            while (end > ownerUuid && (*end == '\n' || *end == '\r' || *end == ' ')) *end-- = '\0';
            clientIdStr = NSStr(ownerUuid);
            saveDict = NewDict();
            DictSet(saveDict, "tamedClientID", clientIdStr);
        }

        SEL loadSel = sel_registerName(
            "loadNPCAtPosition:type:saveDict:isAdult:wasPlaced:placedByClient:");
        IMP imp = objc_msg_lookup(dynWorld, loadSel);
        if (imp) {
            BOOL result = ((BOOL (*)(id, SEL, long long, int, id, BOOL, BOOL, id))imp)(
                dynWorld, loadSel, pos, 6, saveDict, 1, 1, clientIdStr);
            char msg[256];
            snprintf(msg, 256, "[Spawn] Cave troll at (%d, %d) %s%s%s",
                     x, y, result ? "OK" : "FAILED",
                     ownerUuid ? " tamed owner=" : "", ownerUuid ? ownerUuid : "");
            SendChat(self, msg);
        } else {
            SendChat(self, "[Spawn] Error: loadNPCAtPosition not found");
        }

        DrainPool(pool);
        return nil;
    }

    // --- /spawn-boss <x> <y> --- (ADMIN ONLY, requires enableBoss)
    if (strncmp(raw, "/spawn-boss ", 12) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableBoss) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[Boss] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        char buf[512];
        strncpy(buf, raw, 511); buf[511] = '\0';
        char *sp;
        strtok_r(buf, " ", &sp);
        char *xStr = strtok_r(NULL, " ", &sp);
        char *yStr = strtok_r(NULL, " ", &sp);

        if (!xStr || !yStr) {
            SendChat(self, "[Boss] Usage: /spawn-boss <x> <y>");
            DrainPool(pool);
            return nil;
        }

        int x, y;
        parse_int_clamped(xStr, COORD_MIN, COORD_MAX, &x);
        parse_int_clamped(yStr, COORD_MIN, COORD_MAX, &y);
        long long pos = ((long long)(unsigned int)y << 32) | (long long)(unsigned int)x;

        id dict = NewDict();
        DictSet(dict, "name", NSStr("BOSS"));

        SEL loadSel = sel_registerName(
            "loadNPCAtPosition:type:saveDict:isAdult:wasPlaced:placedByClient:");
        IMP imp = objc_msg_lookup(dynWorld, loadSel);
        if (imp) {
            BOOL result = ((BOOL (*)(id, SEL, long long, int, id, BOOL, BOOL, id))imp)(
                dynWorld, loadSel, pos, 6, dict, 1, 1, nil);
            char msg[256];
            snprintf(msg, 256, "[Boss] Boss troll at (%d, %d) %s",
                     x, y, result ? "SPAWNED" : "FAILED");
            SendChat(self, msg);
            fprintf(stderr, "[Boss] Boss troll at (%d, %d) result=%d\n", x, y, result);
        } else {
            SendChat(self, "[Boss] Error: loadNPCAtPosition not found");
        }

        DrainPool(pool);
        return nil;
    }

    // --- /godmode <playerName> --- (ADMIN ONLY, requires enableGodmode)
    if (strncmp(raw, "/godmode ", 9) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableGodmode) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[God] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        const char *nameStart = raw + 9;
        if (*nameStart == '\0') {
            SendChat(self, "[God] Usage: /godmode <playerName>");
            DrainPool(pool);
            return nil;
        }

        char nameBuf[128];
        int j = 0;
        for (int i = 0; nameStart[i] && j < 126; i++) {
            char c = nameStart[i];
            if (c >= 0x20 && c <= 0x7E) nameBuf[j++] = c;
        }
        nameBuf[j] = '\0';
        while (j > 0 && nameBuf[j-1] == ' ') nameBuf[--j] = '\0';

        if (*nameBuf == '\0') {
            SendChat(self, "[God] Usage: /godmode <playerName>");
            DrainPool(pool);
            return nil;
        }

        // SetDefense declared in hook_godmode.h
        extern bool IsGodModeId(unsigned long long uid);

        id blockheads[MAX_BLOCKHEADS_PER_PLAYER];
        int found = FindAllBlockheadsByClientName(dynWorld, nameBuf, blockheads, MAX_BLOCKHEADS_PER_PLAYER);
        if (found == 0) {
            char err[256];
            snprintf(err, 256, "[God] Player '%s' not found (must be online)", nameBuf);
            SendChat(self, err);
            DrainPool(pool);
            return nil;
        }

        // Toggle based on first blockhead's state
        unsigned long long firstUid = *(unsigned long long *)((char *)blockheads[0] + 0x40);
        bool wasEnabled = IsGodModeId(firstUid);
        float newDefense = wasEnabled ? 0.0f : 100.0f;

        for (int i = 0; i < found; i++) {
            unsigned long long uid = *(unsigned long long *)((char *)blockheads[i] + 0x40);
            SetDefense(uid, newDefense);
        }

        bool enabled = !wasEnabled;
        char msg[256];
        snprintf(msg, 256, "[God] God mode %s for %s (%d blockheads)",
                 enabled ? "ENABLED" : "DISABLED", nameBuf, found);
        SendChat(self, msg);
        fprintf(stderr, "[God] %s -> %s (%d blockheads)\n", nameBuf, enabled ? "ON" : "OFF", found);

        DrainPool(pool);
        return nil;
    }

    // --- /defense <playerName> <percent> --- (ADMIN ONLY, requires enableGodmode)
    if (strncmp(raw, "/defense ", 9) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableGodmode) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            fprintf(stderr, "[Defense] Error: World not initialized\n");
            DrainPool(pool);
            return nil;
        }

        // Sanitize the full argument string
        const char *argStart = raw + 9;
        char argBuf[256];
        int j = 0;
        for (int i = 0; argStart[i] && j < 254; i++) {
            char c = argStart[i];
            if (c >= 0x20 && c <= 0x7E) argBuf[j++] = c;
        }
        argBuf[j] = '\0';
        while (j > 0 && argBuf[j-1] == ' ') argBuf[--j] = '\0';

        // Find the last space — everything before it is the name, after is the number
        char *lastSpace = strrchr(argBuf, ' ');
        if (!lastSpace || lastSpace == argBuf) {
            fprintf(stderr, "[Defense] Usage: /defense <playerName> <percent 0-100>\n");
            DrainPool(pool);
            return nil;
        }

        *lastSpace = '\0';
        char *playerName = argBuf;
        float pct = (float)atof(lastSpace + 1);
        if (pct < 0.0f) pct = 0.0f;
        if (pct > 100.0f) pct = 100.0f;

        // SetDefense declared in hook_godmode.h

        id blockheads[MAX_BLOCKHEADS_PER_PLAYER];
        int found = FindAllBlockheadsByClientName(dynWorld, playerName, blockheads, MAX_BLOCKHEADS_PER_PLAYER);
        if (found == 0) {
            fprintf(stderr, "[Defense] Player '%s' not found (must be online)\n", playerName);
            DrainPool(pool);
            return nil;
        }

        for (int i = 0; i < found; i++) {
            unsigned long long uid = *(unsigned long long *)((char *)blockheads[i] + 0x40);
            SetDefense(uid, pct);
        }

        fprintf(stderr, "[Defense] %s -> %.0f%% (%d blockheads)\n", playerName, pct, found);

        DrainPool(pool);
        return nil;
    }

    // --- /buff <playerName> <multiplier> --- (ADMIN ONLY, requires enableGodmode)
    if (strncmp(raw, "/buff ", 6) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableGodmode) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            fprintf(stderr, "[Buff] Error: World not initialized\n");
            DrainPool(pool);
            return nil;
        }

        // Sanitize the full argument string
        const char *argStart = raw + 6;
        char argBuf[256];
        int j = 0;
        for (int i = 0; argStart[i] && j < 254; i++) {
            char c = argStart[i];
            if (c >= 0x20 && c <= 0x7E) argBuf[j++] = c;
        }
        argBuf[j] = '\0';
        while (j > 0 && argBuf[j-1] == ' ') argBuf[--j] = '\0';

        // Find the last space — everything before it is the name, after is the multiplier
        char *lastSpace = strrchr(argBuf, ' ');
        if (!lastSpace || lastSpace == argBuf) {
            fprintf(stderr, "[Buff] Usage: /buff <playerName> <multiplier>\n");
            DrainPool(pool);
            return nil;
        }

        *lastSpace = '\0';
        char *playerName = argBuf;
        float mult = (float)atof(lastSpace + 1);
        if (mult < 0.0f) mult = 0.0f;

        // SetBuff declared in hook_godmode.h

        id blockheads[MAX_BLOCKHEADS_PER_PLAYER];
        int found = FindAllBlockheadsByClientName(dynWorld, playerName, blockheads, MAX_BLOCKHEADS_PER_PLAYER);
        if (found == 0) {
            fprintf(stderr, "[Buff] Player '%s' not found (must be online)\n", playerName);
            DrainPool(pool);
            return nil;
        }

        for (int i = 0; i < found; i++) {
            unsigned long long uid = *(unsigned long long *)((char *)blockheads[i] + 0x40);
            SetBuff(uid, mult);
        }

        fprintf(stderr, "[Buff] %s -> %.2fx (%d blockheads)\n", playerName, mult, found);

        DrainPool(pool);
        return nil;
    }

    // --- /arena set|start|stop --- (ADMIN ONLY, requires enableArena)
    if (strncmp(raw, "/arena ", 7) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableArena) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();

        if (strncmp(raw + 7, "set ", 4) == 0) {
            char buf[256];
            strncpy(buf, raw + 11, 255); buf[255] = '\0';
            char *sp;
            char *x1Str = strtok_r(buf, " ", &sp);
            char *y1Str = strtok_r(NULL, " ", &sp);
            char *x2Str = strtok_r(NULL, " ", &sp);
            char *y2Str = strtok_r(NULL, " ", &sp);
            if (x1Str && y1Str && x2Str && y2Str) {
                int ax1, ay1, ax2, ay2;
                parse_int_clamped(x1Str, COORD_MIN, COORD_MAX, &ax1);
                parse_int_clamped(y1Str, COORD_MIN, COORD_MAX, &ay1);
                parse_int_clamped(x2Str, COORD_MIN, COORD_MAX, &ax2);
                parse_int_clamped(y2Str, COORD_MIN, COORD_MAX, &ay2);
                HandleArenaSet(self, ax1, ay1, ax2, ay2);
            } else {
                SendChat(self, "[Arena] Usage: /arena set <x1> <y1> <x2> <y2>");
            }
        } else if (strncmp(raw + 7, "start", 5) == 0) {
            id world, dynWorld;
            if (GetWorlds(self, &world, &dynWorld)) {
                HandleArenaStart(self, dynWorld);
            } else {
                SendChat(self, "[Arena] Error: World not initialized");
            }
        } else if (strncmp(raw + 7, "stop", 4) == 0) {
            HandleArenaStop(self);
        } else {
            SendChat(self, "[Arena] Usage: /arena set|start|stop");
        }

        DrainPool(pool);
        return nil;
    }

    // --- /claim <ownerName> [radius] --- (ADMIN ONLY, requires enableClaims)
    if (strncmp(raw, "/claim ", 7) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableClaims) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[Claims] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        // Parse: /claim <ownerName> [radius]
        // Since ownerName can have spaces, we treat the LAST token as radius IF it's a number
        const char *argStart = raw + 7;
        char argBuf[256];
        int j = 0;
        for (int i = 0; argStart[i] && j < 254; i++) {
            char c = argStart[i];
            if (c >= 0x20 && c <= 0x7E) argBuf[j++] = c;
        }
        argBuf[j] = '\0';
        while (j > 0 && argBuf[j-1] == ' ') argBuf[--j] = '\0';

        if (*argBuf == '\0') {
            SendChat(self, "[Claims] Usage: /claim <ownerName> [radius]");
            DrainPool(pool);
            return nil;
        }

        // Check if last token is a number (radius)
        int radius = 15; // default
        char *lastSpace = strrchr(argBuf, ' ');
        char *ownerName = argBuf;
        if (lastSpace) {
            char *endPtr;
            long val = strtol(lastSpace + 1, &endPtr, 10);
            if (*endPtr == '\0' && val >= 1 && val <= 61) {
                radius = (int)val;
                *lastSpace = '\0'; // ownerName is everything before the radius
            }
            // else: the last token is part of the name, not a radius
        }

        // Get admin's blockhead position (use client to find blockhead)
        if (!client) {
            SendChat(self, "[Claims] Console cannot claim (no position). Use: /claim-at <x> <y> <ownerName> [radius]");
            DrainPool(pool);
            return nil;
        }

        // Resolve peer ID → player name, then find their blockhead
        const char *adminName = GetClientPlayerName(self, client);
        id adminBh = adminName ? FindBlockhead(dynWorld, adminName) : nil;
        if (!adminBh) {
            SendChat(self, "[Claims] Could not find your blockhead.");
            DrainPool(pool);
            return nil;
        }

        int posX = *(int *)((char *)adminBh + 0x20);
        int posY = *(int *)((char *)adminBh + 0x24);

        // Resolve the target player's clientID (UUID) for land protection
        id ownerBh = FindBlockhead(dynWorld, ownerName);
        const char *ownerUuid = ownerBh ? GetBlockheadClientId(ownerBh) : NULL;
        if (!ownerUuid) {
            char msg[256];
            snprintf(msg, 256, "[Claims] Player '%s' not online — cannot resolve UUID for land protection.", ownerName);
            SendChat(self, msg);
            DrainPool(pool);
            return nil;
        }

        bool ok = PlaceOwnershipSign(dynWorld, posX, posY, ownerName, ownerUuid, radius);
        if (ok) {
            char msg[256];
            snprintf(msg, 256, "[Claims] Placed claim for '%s' at (%d,%d) radius=%d",
                     ownerName, posX, posY, radius);
            SendChat(self, msg);
        } else {
            SendChat(self, "[Claims] Failed to place ownership sign.");
        }

        DrainPool(pool);
        return nil;
    }

    // --- /claim-at <x> <y> <ownerName> [radius] --- (ADMIN/BOT ONLY, requires enableClaims)
    if (strncmp(raw, "/claim-at ", 10) == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableClaims) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[Claims] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        char buf[256];
        strncpy(buf, raw + 10, 255); buf[255] = '\0';
        char *sp;
        char *xStr = strtok_r(buf, " ", &sp);
        char *yStr = strtok_r(NULL, " ", &sp);
        // Rest is owner name + optional radius
        char *rest = sp;

        if (!xStr || !yStr || !rest || *rest == '\0') {
            SendChat(self, "[Claims] Usage: /claim-at <x> <y> <ownerName> [radius]");
            DrainPool(pool);
            return nil;
        }

        int x, y;
        parse_int_clamped(xStr, COORD_MIN, COORD_MAX, &x);
        parse_int_clamped(yStr, COORD_MIN, COORD_MAX, &y);
        int radius = 15;

        // Check if last token is a number (radius)
        char *lastSpace = strrchr(rest, ' ');
        char *ownerName = rest;
        if (lastSpace) {
            char *endPtr;
            long val = strtol(lastSpace + 1, &endPtr, 10);
            if (*endPtr == '\0' && val >= 1 && val <= 61) {
                radius = (int)val;
                *lastSpace = '\0';
            }
        }

        // Resolve the target player's clientID (UUID) for land protection
        id ownerBh = FindBlockhead(dynWorld, ownerName);
        const char *ownerUuid = ownerBh ? GetBlockheadClientId(ownerBh) : NULL;
        if (!ownerUuid) {
            char msg[256];
            snprintf(msg, 256, "[Claims] Player '%s' not online — cannot resolve UUID for land protection.", ownerName);
            SendChat(self, msg);
            DrainPool(pool);
            return nil;
        }

        bool ok = PlaceOwnershipSign(dynWorld, x, y, ownerName, ownerUuid, radius);
        if (ok) {
            char msg[256];
            snprintf(msg, 256, "[Claims] Placed claim for '%s' at (%d,%d) radius=%d",
                     ownerName, x, y, radius);
            SendChat(self, msg);
        } else {
            SendChat(self, "[Claims] Failed to place ownership sign.");
        }

        DrainPool(pool);
        return nil;
    }

    // --- /unclaim --- (ADMIN ONLY, requires enableClaims)
    if (strcmp(raw, "/unclaim") == 0) {
        const HookConfig *cfg = GetHookConfig();
        if (cfg && !cfg->enableClaims) return Real_HandleCmd(self, _cmd, cmdStr, client);
        if (!IsClientAdmin(self, client)) return Real_HandleCmd(self, _cmd, cmdStr, client);

        id pool = AutoreleasePool();
        id world, dynWorld;
        if (!GetWorlds(self, &world, &dynWorld)) {
            SendChat(self, "[Claims] Error: World not initialized");
            DrainPool(pool);
            return nil;
        }

        if (!client) {
            SendChat(self, "[Claims] Console cannot unclaim (no position).");
            DrainPool(pool);
            return nil;
        }

        const char *unclaimName = GetClientPlayerName(self, client);
        id adminBh = unclaimName ? FindBlockhead(dynWorld, unclaimName) : nil;
        if (!adminBh) {
            SendChat(self, "[Claims] Could not find your blockhead.");
            DrainPool(pool);
            return nil;
        }

        int posX = *(int *)((char *)adminBh + 0x20);
        int posY = *(int *)((char *)adminBh + 0x24);

        bool ok = RemoveOwnershipSign(dynWorld, posX, posY);
        if (ok) {
            char msg[128];
            snprintf(msg, 128, "[Claims] Removed claim at (%d,%d)", posX, posY);
            SendChat(self, msg);
        } else {
            SendChat(self, "[Claims] No ownership sign found at your position.");
        }

        DrainPool(pool);
        return nil;
    }

    // --- /give and /give-id (ADMIN ONLY) ---
    bool isGiveById = (strncmp(raw, "/give-id ", 9) == 0);
    bool isGive     = (strncmp(raw, "/give ", 6) == 0);
    if (!isGive && !isGiveById)
        return Real_HandleCmd(self, _cmd, cmdStr, client);

    if (!IsClientAdmin(self, client))
        return Real_HandleCmd(self, _cmd, cmdStr, client);

    id pool = AutoreleasePool();

    id world, dynWorld;
    if (!GetWorlds(self, &world, &dynWorld)) {
        SendChat(self, "[Give] Error: World not initialized");
        DrainPool(pool);
        return nil;
    }

    char buffer[512];
    strncpy(buffer, raw, 511);
    buffer[511] = '\0';
    char *saveptr;
    strtok_r(buffer, " ", &saveptr);

    if (isGiveById) {
        char *idStr     = strtok_r(NULL, " ", &saveptr);
        char *itemIdStr = strtok_r(NULL, " ", &saveptr);
        char *countStr  = strtok_r(NULL, " ", &saveptr);

        if (!idStr || !itemIdStr) {
            SendChat(self, "[Give] Usage: /give-id <BLOCKHEAD_ID> <ITEM_ID> [COUNT]");
            DrainPool(pool);
            return nil;
        }

        unsigned long long blockheadId = strtoull(idStr, NULL, 10);
        int itemId, count;
        parse_int_clamped(itemIdStr, 1, 9999, &itemId);
        if (!countStr || !parse_int_clamped(countStr, 1, 999, &count)) count = 1;
        if (count > 999) count = 999;

        id blockhead = FindBlockheadById(dynWorld, blockheadId);
        if (!blockhead) {
            char err[256];
            snprintf(err, 256, "[Give] Error: Blockhead ID %llu not found (must be online)", blockheadId);
            SendChat(self, err);
            DrainPool(pool);
            return nil;
        }

        SpawnItem(dynWorld, blockhead, itemId, count);
        fprintf(stderr, "[Give] Gave %dx item %d to blockhead %llu\n", count, itemId, blockheadId);
    } else {
        char *playerName = strtok_r(NULL, " ", &saveptr);
        char *itemIdStr  = strtok_r(NULL, " ", &saveptr);
        char *countStr   = strtok_r(NULL, " ", &saveptr);

        if (!playerName || !itemIdStr) {
            SendChat(self, "[Give] Usage: /give <PLAYER> <ITEM_ID> [COUNT]");
            DrainPool(pool);
            return nil;
        }

        int itemId, count;
        parse_int_clamped(itemIdStr, 1, 9999, &itemId);
        if (!countStr || !parse_int_clamped(countStr, 1, 999, &count)) count = 1;

        id blockhead = FindBlockhead(dynWorld, playerName);
        if (!blockhead) {
            char err[256];
            snprintf(err, 256, "[Give] Error: Player '%s' not found (must be online)", playerName);
            SendChat(self, err);
            DrainPool(pool);
            return nil;
        }

        SpawnItem(dynWorld, blockhead, itemId, count);
        fprintf(stderr, "[Give] Gave %dx item %d to %s\n", count, itemId, playerName);
    }

    DrainPool(pool);
    return nil;
}
