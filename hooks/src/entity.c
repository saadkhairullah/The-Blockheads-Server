#include "entity.h"
#include "objc_helpers.h"

// --- Native teleport (bypass canTeleportToPos check) ---
typedef struct { int x, y; } intpair;
typedef BOOL (*CanTeleportFunc)(id, SEL, intpair);
typedef BOOL (*TeleportToFunc)(id, SEL, intpair);

static bool g_forceTeleport = false;
static CanTeleportFunc Orig_CanTeleport = NULL;

static BOOL Hook_CanTeleport(id self, SEL _cmd, intpair pos) {
    if (g_forceTeleport) return 1;
    return Orig_CanTeleport(self, _cmd, pos);
}

void InitTeleportHooks(void) {
    Class bhClass = objc_getClass("Blockhead");
    if (!bhClass) {
        fprintf(stderr, "[Teleport] Blockhead class not found.\n");
        return;
    }

    SEL canTpSel = sel_registerName("canTeleportToPos:");
    Method m = class_getInstanceMethod(bhClass, canTpSel);
    if (!m) {
        fprintf(stderr, "[Teleport] canTeleportToPos: not found.\n");
        return;
    }

    Orig_CanTeleport = (CanTeleportFunc)method_getImplementation(m);
    method_setImplementation(m, (IMP)Hook_CanTeleport);
    fprintf(stderr, "[Teleport] canTeleportToPos: hooked (forced bypass available).\n");
}

int TeleportBlockhead(id blockhead, int x, int y) {
    if (!blockhead) return 0;

    SEL teleportSel = sel_registerName("teleportToPos:");
    IMP imp = objc_msg_lookup(blockhead, teleportSel);
    if (!imp) return 0;

    intpair dest = { x, y };

    g_forceTeleport = true;
    BOOL result = ((TeleportToFunc)imp)(blockhead, teleportSel, dest);
    g_forceTeleport = false;

    return result ? 1 : 0;
}

id FindBlockhead(id dynWorld, const char* name) {
    if (!dynWorld || !name) return nil;

    id pool = AutoreleasePool();

    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) { DrainPool(pool); return nil; }
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

id FindBlockheadById(id dynWorld, unsigned long long uid) {
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
    for (int i = 0; i < count; i++) {
        id bh = fIdx(list, sIdx, i);
        if (!bh) continue;
        // uniqueID is uint64_t at offset 0x40 in DynamicObject
        unsigned long long bhUid = *(unsigned long long*)((char*)bh + 0x40);
        if (bhUid == uid) return bh;
    }
    return nil;
}

id FindBlockheadByDisplayName(id dynWorld, const char* displayName) {
    if (!dynWorld || !displayName) return nil;

    id pool = AutoreleasePool();

    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) { DrainPool(pool); return nil; }
    id list = *(id*)((char*)dynWorld + ivar_getOffset(iv));
    if (!list) { DrainPool(pool); return nil; }

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    SEL sName = sel_registerName("name");

    IntFunc fCnt = (IntFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sCnt));
    IdxFunc fIdx = (IdxFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sIdx));
    if (!fCnt || !fIdx) { DrainPool(pool); return nil; }

    int count = fCnt(list, sCnt);
    for (int i = 0; i < count; i++) {
        id bh = fIdx(list, sIdx, i);
        if (!bh) continue;

        IMP nameImp = objc_msg_lookup(bh, sName);
        if (!nameImp) continue;
        id nameObj = ((id (*)(id, SEL))nameImp)(bh, sName);
        if (!nameObj) continue;

        const char *bhName = ToCStr(nameObj);
        if (bhName && strcasecmp(bhName, displayName) == 0) {
            DrainPool(pool);
            return bh;
        }
    }
    DrainPool(pool);
    return nil;
}

int FindAllBlockheadsByClientName(id dynWorld, const char* clientName, id *outBlockheads, int maxResults) {
    if (!dynWorld || !clientName || !outBlockheads || maxResults <= 0) return 0;

    id pool = AutoreleasePool();

    Ivar iv = class_getInstanceVariable(object_getClass(dynWorld), "netBlockheads");
    if (!iv) { DrainPool(pool); return 0; }
    id list = *(id*)((char*)dynWorld + ivar_getOffset(iv));
    if (!list) { DrainPool(pool); return 0; }

    SEL sCnt = sel_registerName("count");
    SEL sIdx = sel_registerName("objectAtIndex:");
    SEL sClientName = sel_registerName("clientName");
    SEL sComp = sel_registerName("caseInsensitiveCompare:");

    IntFunc fCnt = (IntFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sCnt));
    IdxFunc fIdx = (IdxFunc)method_getImplementation(class_getInstanceMethod(object_getClass(list), sIdx));
    if (!fCnt || !fIdx) { DrainPool(pool); return 0; }

    int count = fCnt(list, sCnt);
    id target = NSStr(clientName);
    int found = 0;

    for (int i = 0; i < count && found < maxResults; i++) {
        id bh = fIdx(list, sIdx, i);
        if (!bh) continue;

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
                outBlockheads[found++] = bh;
            }
        }
    }

    DrainPool(pool);
    return found;
}

const char* GetBlockheadClientId(id blockhead) {
    if (!blockhead) return NULL;
    // Blockhead.clientID is an NSString at offset 0xc0 (confirmed via Ghidra DWARF)
    id clientIdObj = *(id *)((char *)blockhead + 0xc0);
    if (!clientIdObj) return NULL;
    return ToCStr(clientIdObj);
}

void SpawnItem(id dynWorld, id player, int itemId, int count) {
    if (!player || !dynWorld) return;

    id pool = AutoreleasePool();

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
