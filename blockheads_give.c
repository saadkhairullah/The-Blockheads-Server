// Blockheads Server Item Injection
// Provides /give <PLAYER> <ITEM_ID> [COUNT]       — find by player name
//          /give-id <BLOCKHEAD_ID> <ITEM_ID> [COUNT] — find by uint64 uniqueID (more reliable)

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include <pthread.h>
#include <stdbool.h>
#include <stdint.h>
#include <ctype.h>
#include <sys/mman.h>
#include <objc/runtime.h>
#include <objc/message.h>

// --- CONFIG ---
#define SERVER_CLASS "BHServer"
// Set BH_ADMIN_LIST_PATH in the environment before starting the server, e.g.:
//   BH_ADMIN_LIST_PATH=/path/to/saves/YOUR_WORLD_UUID/adminlist.txt LD_PRELOAD=...
#define ADMIN_LIST_PATH_ENV "BH_ADMIN_LIST_PATH"

// --- IMP TYPES ---
typedef id (*CmdFunc)(id, SEL, id, id);
typedef void (*ChatFunc)(id, SEL, id, BOOL, id);
typedef id (*SpawnFunc)(id, SEL, long long, int, int, int, id, id, BOOL, BOOL, id);

typedef id (*AllocFunc)(id, SEL);
typedef id (*InitFunc)(id, SEL);
typedef void (*VoidFunc)(id, SEL);
typedef id (*StrFunc)(id, SEL, const char*);
typedef const char* (*Utf8Func)(id, SEL);
typedef int (*IntFunc)(id, SEL);
typedef id (*IdxFunc)(id, SEL, int);
typedef id (*GetterFunc)(id, SEL);
typedef long (*CompFunc)(id, SEL, id);
// uniqueID is uint64_t (confirmed via DWARF debug info in binary)
typedef id (*ByUniqueIdFunc)(id, SEL, unsigned long long);
// --- DETOUR TYPES ---
typedef id (*UpdateNetDataFunc)(id, SEL, id);

// --- GLOBALS ---
static CmdFunc Real_HandleCmd = NULL;
static ChatFunc Real_SendChat = NULL;
static UpdateNetDataFunc Orig_UpdateNetData = NULL;

// --- PRICE HOOK CACHE ---
static id  g_emptyDict      = NULL;
static SEL g_sRelease       = NULL;
static SEL g_sRetain        = NULL;
static SEL g_sRemoveAll     = NULL;

// --- UTILS ---
static id AutoreleasePool() {
    Class cls = objc_getClass("NSAutoreleasePool");
    SEL sA = sel_registerName("alloc");
    SEL sI = sel_registerName("init");
    AllocFunc fA = (AllocFunc)method_getImplementation(class_getClassMethod(cls, sA));
    InitFunc fI = (InitFunc)method_getImplementation(class_getInstanceMethod(cls, sI));
    return fI(fA((id)cls, sA), sI);
}

static void DrainPool(id pool) {
    if (!pool) return;
    SEL s = sel_registerName("drain");
    VoidFunc f = (VoidFunc)method_getImplementation(class_getInstanceMethod(object_getClass(pool), s));
    f(pool, s);
}

static id NSStr(const char* txt) {
    if (!txt) return nil;
    Class cls = objc_getClass("NSString");
    SEL s = sel_registerName("stringWithUTF8String:");
    StrFunc f = (StrFunc)method_getImplementation(class_getClassMethod(cls, s));
    return f ? f((id)cls, s, txt) : nil;
}

static const char* ToCStr(id str) {
    if (!str) return "";
    SEL s = sel_registerName("UTF8String");
    Utf8Func f = (Utf8Func)method_getImplementation(class_getInstanceMethod(object_getClass(str), s));
    return f ? f(str, s) : "";
}

static void SendChat(id server, const char* msg) {
    if (server && Real_SendChat) {
        Real_SendChat(server, sel_registerName("sendChatMessage:displayNotification:sendToClients:"), NSStr(msg), true, nil);
    }
}

// --- FIND BLOCKHEAD BY NAME ---
static id FindBlockhead(id dynWorld, const char* name) {
    if (!dynWorld || !name) return nil;

    id pool = AutoreleasePool();

    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) {
        DrainPool(pool);
        return nil;
    }
    id list = *(id*)((char*)dynWorld + ivar_getOffset(iv));

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    SEL sClientName = sel_registerName("clientName");
    SEL sComp = sel_registerName("caseInsensitiveCompare:");

    IntFunc fCnt = (IntFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sCnt));
    IdxFunc fIdx = (IdxFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sIdx));

    int count = fCnt(list, sCnt);
    id target = NSStr(name);

    for (int i = 0; i < count; i++) {
        id bh = fIdx(list, sIdx, i);
        id cName = nil;

        Method mName = class_getInstanceMethod(object_getClass(bh), sClientName);
        if (mName) {
            GetterFunc fName = (GetterFunc)method_getImplementation(mName);
            cName = fName(bh, sClientName);
        } else {
            Ivar ivN = class_getInstanceVariable(object_getClass(bh), "clientName");
            if (ivN) cName = *(id*)((char*)bh + ivar_getOffset(ivN));
        }

        if (cName) {
            CompFunc fComp = (CompFunc)method_getImplementation(class_getInstanceMethod(object_getClass(cName), sComp));
            if (fComp(cName, sComp, target) == 0) {
                DrainPool(pool);
                return bh;
            }
        }
    }
    DrainPool(pool);
    return nil;
}

// --- FIND BLOCKHEAD BY UNIQUE ID ---
// Searches netBlockheads by uniqueID (uint64_t at offset 64).
// blockheadWithUniqueID: only searches the AI/offline 'blockheads' list — NOT netBlockheads.
// Online players' blockheads are in netBlockheads, so we must iterate it directly.
static id FindBlockheadById(id dynWorld, unsigned long long uid) {
    if (!dynWorld) return nil;

    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) return nil;
    id list = *(id*)((char*)dynWorld + ivar_getOffset(iv));
    if (!list) return nil;

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    IntFunc fCnt = (IntFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sCnt));
    IdxFunc fIdx = (IdxFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sIdx));
    if (!fCnt || !fIdx) return nil;

    int count = fCnt(list, sCnt);
    // uniqueID is a uint64_t ivar at offset 64 in DynamicObject (Blockhead's base class)
    for (int i = 0; i < count; i++) {
        id bh = fIdx(list, sIdx, i);
        if (!bh) continue;
        unsigned long long bhUid = *(unsigned long long*)((char*)bh + 64);
        if (bhUid == uid) return bh;
    }
    return nil;
}

// --- SPAWN ITEM AT PLAYER ---
static void SpawnItem(id dynWorld, id player, int itemId, int count) {
    if (!player || !dynWorld) return;

    id pool = AutoreleasePool();

    // Read position via 'pos' ivar (matches the working libblockheads_give.so from Feb 17)
    Ivar ivPos = class_getInstanceVariable(object_getClass(player), "pos");
    if (!ivPos) {
        fprintf(stderr, "[Give] Error: 'pos' ivar not found on player\n");
        DrainPool(pool);
        return;
    }
    long long pos = *(long long*)((char*)player + ivar_getOffset(ivPos));

    SEL sSpawn = sel_registerName("createFreeBlockAtPosition:ofType:dataA:dataB:subItems:dynamicObjectSaveDict:hovers:playSound:priorityBlockhead:");
    SpawnFunc fSpawn = (SpawnFunc)method_getImplementation(class_getInstanceMethod(object_getClass(dynWorld), sSpawn));

    for (int i = 0; i < count; i++) {
        fSpawn(dynWorld, sSpawn, pos, itemId, 1, 0, nil, nil, 1, 0, player);
    }

    DrainPool(pool);
}

// --- ADMIN CHECK ---
// Reads adminlist.txt — first line is a header (skipped), rest are names, case-insensitive.
static bool IsAdmin(const char* name) {
    if (!name || !*name) return false;
    const char* path = getenv(ADMIN_LIST_PATH_ENV);
    if (!path || !*path) {
        fprintf(stderr, "[Give] Warning: BH_ADMIN_LIST_PATH not set — admin check will always fail\n");
        return false;
    }
    FILE* f = fopen(path, "r");
    if (!f) return false;
    char line[256];
    bool firstLine = true;
    bool found = false;
    while (fgets(line, sizeof(line), f)) {
        if (firstLine) { firstLine = false; continue; }
        // Trim trailing whitespace/newline
        int len = (int)strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r' || line[len-1] == ' '))
            line[--len] = '\0';
        if (len == 0) continue;
        if (strcasecmp(line, name) == 0) { found = true; break; }
    }
    fclose(f);
    return found;
}

// --- PRICE FLUCTUATION HOOKS (ObjC method swizzle — defense in depth) ---
static id Hook_UpdatePrice(id self, SEL _cmd, id typeKey, float soldCount) {
    return nil;
}

static void Hook_UpdateTradePricesIfNeeded(id self, SEL _cmd) {
}

// --- BINARY DETOUR INFRASTRUCTURE ---
// Write a 13-byte absolute jump: movabs $addr, %r11; jmp *%r11
// Uses r11 (caller-saved scratch register) to avoid clobbering function args.
static void write_detour_jmp(unsigned char *buf, void *target) {
    buf[0] = 0x49; buf[1] = 0xbb;  // movabs $imm64, %r11
    memcpy(buf + 2, &target, 8);
    buf[10] = 0x41; buf[11] = 0xff; buf[12] = 0xe3;  // jmp *%r11
}

// Install binary detour: overwrites function entry to jump to hook.
// stolen_len = bytes at function entry to relocate (>= 13, must be on instruction boundary).
// Returns trampoline pointer for calling the original function, or NULL on failure.
static void *install_detour(void *func, void *hook, int stolen_len) {
    if (stolen_len < 13) return NULL;

    // Allocate executable trampoline: stolen prologue + 13-byte jump back
    int tramp_size = stolen_len + 13;
    unsigned char *tramp = mmap(NULL, tramp_size,
                                PROT_READ | PROT_WRITE | PROT_EXEC,
                                MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tramp == MAP_FAILED) return NULL;

    // Copy stolen prologue bytes to trampoline
    memcpy(tramp, func, stolen_len);
    // Append jump back to original function + stolen_len
    write_detour_jmp(tramp + stolen_len, (unsigned char *)func + stolen_len);

    // Overwrite function entry with jump to hook
    uintptr_t page = (uintptr_t)func & ~0xFFF;
    if (mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        munmap(tramp, tramp_size);
        return NULL;
    }
    write_detour_jmp(func, hook);
    // NOP any remaining bytes
    for (int i = 13; i < stolen_len; i++)
        ((unsigned char *)func)[i] = 0x90;
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);

    return tramp;
}

// --- TRADE PORTAL PRICE FREEZE HOOKS ---
// Architecture (confirmed via Ghidra decompilation):
//   - buyItem/sellItem NEVER run on the server (guarded by currentBlockhead != NULL)
//   - Client computes prices locally, sends state via remoteUpdate:
//   - Server stores client's localPriceOffsets (dict at self+0xd0)
//   - Server sends offsets to other clients via updateNetDataForClient:
//   - Clients receiving offsets use them to compute displayed/charged prices
//
// Fix: Hook updateNetDataForClient: to always send EMPTY localPriceOffsets.
//      This ensures all clients compute baseline prices from the server.
//      Also hook remoteUpdate: to clear offsets after processing client data.

static id Hook_UpdateNetDataForClient(id self, SEL _cmd, id clientID) {
    // Clear localPriceOffsets (ivar at self+0xd0) before the original reads it.
    // Reuse a single pre-allocated empty NSMutableDictionary instead of
    // alloc+init on every call — avoids heap churn on the hot networking path.
    id *pOffsets = (id *)((char *)self + 0xd0);
    if (*pOffsets != g_emptyDict) {
        if (*pOffsets != nil)
            ((void (*)(id, SEL))objc_msg_lookup(*pOffsets, g_sRelease))(*pOffsets, g_sRelease);
        ((void (*)(id, SEL))objc_msg_lookup(g_emptyDict, g_sRetain))(g_emptyDict, g_sRetain);
        *pOffsets = g_emptyDict;
    }

    id result = Orig_UpdateNetData(self, _cmd, clientID);

    // Guard: clear the shared dict in case the original mutated it.
    ((void (*)(id, SEL))objc_msg_lookup(g_emptyDict, g_sRemoveAll))(g_emptyDict, g_sRemoveAll);

    return result;
}

// Patch loadPriceOffsets: to return immediately (0xc3 = ret).
// Defense-in-depth: prevents loading offsets from client remoteUpdate data.
static void PatchLoadPriceOffsets(void) {
    unsigned char *fn = (unsigned char *)0x7f8f90;
    if (fn[0] != 0x55) {
        fprintf(stderr, "[Patch] loadPriceOffsets first byte mismatch (0x%02x) — skipping\n", fn[0]);
        return;
    }
    uintptr_t page = (uintptr_t)fn & ~0xFFF;
    if (mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        fprintf(stderr, "[Patch] loadPriceOffsets mprotect failed — skipping\n");
        return;
    }
    fn[0] = 0xc3;
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);
    fprintf(stderr, "[Patch] loadPriceOffsets patched to ret — blocks client price data.\n");
}

// --- COMMAND HOOK ---
static id Hook_HandleCmd(id self, SEL _cmd, id cmdStr, id client) {
    const char* raw = ToCStr(cmdStr);
    if (!raw) return Real_HandleCmd(self, _cmd, cmdStr, client);

    bool isGiveById = (strncmp(raw, "/give-id ", 9) == 0);
    bool isGive     = (strncmp(raw, "/give ", 6) == 0);
    if (!isGive && !isGiveById) {
        return Real_HandleCmd(self, _cmd, cmdStr, client);
    }

    // For player-originated commands (client != nil), only allow admins.
    // Non-admins fall through to native handler (which rejects them).
    if (client != nil) {
        id cNameObj = nil;
        SEL sClientName = sel_registerName("clientName");
        Method mName = class_getInstanceMethod(object_getClass(client), sClientName);
        if (mName) {
            GetterFunc f = (GetterFunc)method_getImplementation(mName);
            cNameObj = f(client, sClientName);
        } else {
            Ivar iv = class_getInstanceVariable(object_getClass(client), "clientName");
            if (iv) cNameObj = *(id*)((char*)client + ivar_getOffset(iv));
        }
        if (!IsAdmin(ToCStr(cNameObj))) {
            return Real_HandleCmd(self, _cmd, cmdStr, client);
        }
    }

    id pool = AutoreleasePool();

    // Get world (shared by both paths)
    id world = nil;
    object_getInstanceVariable(self, "world", (void**)&world);
    id dynWorld = nil;
    if (world) object_getInstanceVariable(world, "dynamicWorld", (void**)&dynWorld);

    if (!dynWorld) {
        SendChat(self, "[Give] Error: World not initialized");
        DrainPool(pool);
        return nil;
    }

    char buffer[512];
    strncpy(buffer, raw, 511);
    buffer[511] = '\0';
    char *saveptr;
    strtok_r(buffer, " ", &saveptr);  // skip command name

    if (isGiveById) {
        // /give-id <BLOCKHEAD_ID> <ITEM_ID> [COUNT]
        char *idStr     = strtok_r(NULL, " ", &saveptr);
        char *itemIdStr = strtok_r(NULL, " ", &saveptr);
        char *countStr  = strtok_r(NULL, " ", &saveptr);

        if (!idStr || !itemIdStr) {
            SendChat(self, "[Give] Usage: /give-id <BLOCKHEAD_ID> <ITEM_ID> [COUNT]");
            DrainPool(pool);
            return nil;
        }

        unsigned long long blockheadId = strtoull(idStr, NULL, 10);
        int itemId = atoi(itemIdStr);
        int count = countStr ? atoi(countStr) : 1;
        if (count < 1) count = 1;
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
        // /give <PLAYER> <ITEM_ID> [COUNT]
        char *playerName = strtok_r(NULL, " ", &saveptr);
        char *itemIdStr  = strtok_r(NULL, " ", &saveptr);
        char *countStr   = strtok_r(NULL, " ", &saveptr);

        if (!playerName || !itemIdStr) {
            SendChat(self, "[Give] Usage: /give <PLAYER> <ITEM_ID> [COUNT]");
            DrainPool(pool);
            return nil;
        }

        int itemId = atoi(itemIdStr);
        int count = countStr ? atoi(countStr) : 1;
        if (count < 1) count = 1;
        if (count > 999) count = 999;

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

// --- PATCH: pollNetEvents crash fix ---
// BHNetServerMatch::pollNetEvents has a @catch handler that calls exit(0) on ANY
// NSRangeException (e.g. from a malformed/truncated network packet).
// This kills the entire server for one bad packet.
// Fix: patch the exit(0) call to jump to the function's return epilogue instead.
// The NSLog error message still prints, but the server continues running.
static void PatchPollNetEventsCrash(void) {
    // Non-PIE binary — addresses are fixed
    // exit(0) call at VA 0x4fb3e4: e8 17 ed fc ff
    // Return epilogue at VA 0x4fb32b: add $0x320,%rsp; pop %rbp; ret
    unsigned char *exit_call = (unsigned char *)0x4fb3e4;

    // Verify we're patching the right bytes
    if (exit_call[0] != 0xe8 || exit_call[1] != 0x17 || exit_call[2] != 0xed) {
        fprintf(stderr, "[Patch] pollNetEvents exit() bytes don't match — skipping patch\n");
        return;
    }

    // Make the page writable
    uintptr_t page = (uintptr_t)exit_call & ~0xFFF;
    if (mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC) != 0) {
        fprintf(stderr, "[Patch] mprotect failed — skipping patch\n");
        return;
    }

    // Replace: call exit  →  jmp 0x4fb32b (return epilogue)
    // rel32 = 0x4fb32b - (0x4fb3e4 + 5) = -0xbe = 0xFFFFFF42
    exit_call[0] = 0xe9;  // jmp rel32
    exit_call[1] = 0x42;
    exit_call[2] = 0xff;
    exit_call[3] = 0xff;
    exit_call[4] = 0xff;

    // Restore page permissions
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);
    fprintf(stderr, "[Patch] pollNetEvents crash-on-exception patched — server will survive bad packets\n");
}

// --- INIT ---
static void* InitHook(void* arg) {
    sleep(1);  // Wait for server to initialize

    // Patch pollNetEvents before hooking commands
    PatchPollNetEventsCrash();

    Class clsServer = objc_getClass(SERVER_CLASS);
    if (clsServer) {
        Method mCmd = class_getInstanceMethod(clsServer, sel_registerName("handleCommand:issueClient:"));
        Real_HandleCmd = (CmdFunc)method_getImplementation(mCmd);
        method_setImplementation(mCmd, (IMP)Hook_HandleCmd);

        Method mChat = class_getInstanceMethod(clsServer, sel_registerName("sendChatMessage:displayNotification:sendToClients:"));
        Real_SendChat = (ChatFunc)method_getImplementation(mChat);

        fprintf(stderr, "[Give] Hooked into Blockheads server. /give and /give-id commands ready.\n");
    } else {
        fprintf(stderr, "[Give] Error: Could not find BHServer class\n");
    }

    // Pre-allocate shared empty dict for updateNetDataForClient: hook
    g_sRelease   = sel_registerName("release");
    g_sRetain    = sel_registerName("retain");
    g_sRemoveAll = sel_registerName("removeAllObjects");
    {
        Class clsDict = objc_getClass("NSMutableDictionary");
        SEL sAlloc = sel_registerName("alloc");
        SEL sInit  = sel_registerName("init");
        id d = ((id (*)(id, SEL))objc_msg_lookup((id)clsDict, sAlloc))((id)clsDict, sAlloc);
        d    = ((id (*)(id, SEL))objc_msg_lookup(d, sInit))(d, sInit);
        // Retain permanently — this dict lives for the server's lifetime
        ((void (*)(id, SEL))objc_msg_lookup(d, g_sRetain))(d, g_sRetain);
        g_emptyDict = d;
        fprintf(stderr, "[Price] Pre-allocated shared empty dict for price hook.\n");
    }

    // Hook trade portal price updates (World class, separate from BHServer)
    Class clsWorld = objc_getClass("World");
    if (clsWorld) {
        Method mPrice = class_getInstanceMethod(clsWorld, sel_registerName("updatePriceForItemBoughtOrSoldOfTypeKey:soldCount:"));
        if (mPrice) {
            method_setImplementation(mPrice, (IMP)Hook_UpdatePrice);
            fprintf(stderr, "[Give] Per-transaction price drift disabled.\n");
        } else {
            fprintf(stderr, "[Give] Warning: could not find updatePriceForItemBoughtOrSoldOfTypeKey:soldCount:\n");
        }

        Method mSync = class_getInstanceMethod(clsWorld, sel_registerName("updateTradePricesIfNeeded"));
        if (mSync) {
            method_setImplementation(mSync, (IMP)Hook_UpdateTradePricesIfNeeded);
            fprintf(stderr, "[Give] Price server sync disabled.\n");
        } else {
            fprintf(stderr, "[Give] Warning: could not find updateTradePricesIfNeeded\n");
        }
    } else {
        fprintf(stderr, "[Give] Warning: could not find World class for price hook.\n");
    }

    // Patch loadPriceOffsets: to block client-sent price drift via remoteUpdate:
    PatchLoadPriceOffsets();

    // Install binary detours on TradePortal methods.
    // These are the REAL fix — buyItem/sellItem never execute on the server
    // (Ghidra confirmed: guarded by currentBlockhead != NULL, always false server-side).
    // The server receives price data via remoteUpdate: and sends it via updateNetDataForClient:.

    // Hook updateNetDataForClient: @ 0x7fa6b0
    // Stolen bytes (15): push rbp(1) + mov rsp,rbp(3) + sub $0x160,rsp(7) + lea -0x48(rbp),rax(4)
    {
        unsigned char *fn = (unsigned char *)0x7fa6b0;
        if (fn[0] == 0x55 && fn[1] == 0x48 && fn[2] == 0x89 && fn[3] == 0xe5) {
            void *tramp = install_detour((void *)0x7fa6b0, (void *)Hook_UpdateNetDataForClient, 15);
            if (tramp) {
                Orig_UpdateNetData = (UpdateNetDataFunc)tramp;
                fprintf(stderr, "[Detour] updateNetDataForClient: hooked — clients will receive baseline prices.\n");
            } else {
                fprintf(stderr, "[Detour] updateNetDataForClient: detour install failed.\n");
            }
        } else {
            fprintf(stderr, "[Detour] updateNetDataForClient: prologue mismatch — skipping.\n");
        }
    }


    return NULL;
}

__attribute__((constructor)) static void Entry() {
    pthread_t t;
    pthread_create(&t, NULL, InitHook, NULL);
}
