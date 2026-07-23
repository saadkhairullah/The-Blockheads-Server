#include "bh_common.h"
#include "detour.h"

// --- Trade portal price freeze ---
// Architecture: Client computes prices locally, sends via remoteUpdate:.
// Server stores localPriceOffsets (self+0xd0), sends to other clients.
// Fix: Hook updateNetDataForClient: to send empty offsets.
//      Patch loadPriceOffsets: to block client-sent drift.

static UpdateNetDataFunc Orig_UpdateNetData = NULL;
static id  g_emptyDict  = NULL;
static SEL g_sRelease   = NULL;
static SEL g_sRetain    = NULL;
static SEL g_sRemoveAll = NULL;

static id Hook_UpdatePrice(id self, SEL _cmd, id typeKey, float soldCount) {
    return nil;
}

static void Hook_UpdateTradePricesIfNeeded(id self, SEL _cmd) {
    // no-op: block server-side price sync
}

static id Hook_UpdateNetDataForClient(id self, SEL _cmd, id clientID) {
    // Clear localPriceOffsets (self+0xd0) before the original reads it
    id *pOffsets = (id *)((char *)self + 0xd0);
    if (*pOffsets != g_emptyDict) {
        if (*pOffsets != nil)
            ((void (*)(id, SEL))objc_msg_lookup(*pOffsets, g_sRelease))(*pOffsets, g_sRelease);
        ((void (*)(id, SEL))objc_msg_lookup(g_emptyDict, g_sRetain))(g_emptyDict, g_sRetain);
        *pOffsets = g_emptyDict;
    }

    id result = Orig_UpdateNetData(self, _cmd, clientID);

    // Clear shared dict in case original mutated it
    ((void (*)(id, SEL))objc_msg_lookup(g_emptyDict, g_sRemoveAll))(g_emptyDict, g_sRemoveAll);
    return result;
}

static void PatchLoadPriceOffsets(void) {
    unsigned char *fn = (unsigned char *)0x7f8f90;
    if (fn[0] != 0x55) {
        fprintf(stderr, "[Trade] loadPriceOffsets first byte mismatch (0x%02x) — skipping\n", fn[0]);
        return;
    }
    if (patch_byte(fn, 0xc3)) {
        fprintf(stderr, "[Trade] loadPriceOffsets patched to ret.\n");
    }
}

void InitTradeHooks(void) {
    // Pre-allocate shared empty dict
    g_sRelease   = sel_registerName("release");
    g_sRetain    = sel_registerName("retain");
    g_sRemoveAll = sel_registerName("removeAllObjects");
    {
        Class clsDict = objc_getClass("NSMutableDictionary");
        if (!clsDict) { fprintf(stderr, "[Trade] NSMutableDictionary not found\n"); return; }
        SEL sAlloc = sel_registerName("alloc");
        SEL sInit  = sel_registerName("init");
        IMP allocImp = objc_msg_lookup((id)clsDict, sAlloc);
        if (!allocImp) { fprintf(stderr, "[Trade] alloc IMP not found\n"); return; }
        id d = ((id (*)(id, SEL))allocImp)((id)clsDict, sAlloc);
        if (!d) { fprintf(stderr, "[Trade] alloc returned nil\n"); return; }
        IMP initImp = objc_msg_lookup(d, sInit);
        if (!initImp) { fprintf(stderr, "[Trade] init IMP not found\n"); return; }
        d = ((id (*)(id, SEL))initImp)(d, sInit);
        ((void (*)(id, SEL))objc_msg_lookup(d, g_sRetain))(d, g_sRetain);
        g_emptyDict = d;
    }

    // Hook World price methods
    Class clsWorld = objc_getClass("World");
    if (clsWorld) {
        Method mPrice = class_getInstanceMethod(clsWorld, sel_registerName("updatePriceForItemBoughtOrSoldOfTypeKey:soldCount:"));
        if (mPrice) {
            method_setImplementation(mPrice, (IMP)Hook_UpdatePrice);
            fprintf(stderr, "[Trade] Per-transaction price drift disabled.\n");
        }

        Method mSync = class_getInstanceMethod(clsWorld, sel_registerName("updateTradePricesIfNeeded"));
        if (mSync) {
            method_setImplementation(mSync, (IMP)Hook_UpdateTradePricesIfNeeded);
            fprintf(stderr, "[Trade] Price server sync disabled.\n");
        }
    }

    // Patch loadPriceOffsets
    PatchLoadPriceOffsets();

    // Detour updateNetDataForClient: @ 0x7fa6b0
    unsigned char *fn = (unsigned char *)0x7fa6b0;
    if (fn[0] == 0x55 && fn[1] == 0x48 && fn[2] == 0x89 && fn[3] == 0xe5) {
        void *tramp = install_detour((void *)0x7fa6b0, (void *)Hook_UpdateNetDataForClient, 15);
        if (tramp) {
            Orig_UpdateNetData = (UpdateNetDataFunc)tramp;
            fprintf(stderr, "[Trade] updateNetDataForClient: hooked — baseline prices.\n");
        } else {
            fprintf(stderr, "[Trade] updateNetDataForClient: detour failed.\n");
        }
    }

    fprintf(stderr, "[Trade] Price freeze hooks installed.\n");
}
