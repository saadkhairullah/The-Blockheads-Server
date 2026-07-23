#include "bh_common.h"
#include "objc_helpers.h"
#include "hook_claims.h"

// =============================================================================
// Landclaim System — Programmatic OwnershipSign Placement
//
// Uses the game's built-in OwnershipSign system to create tile protection.
// Signs are placed via DynamicWorld::interactionObjectPlacedAtPosition:
// which handles all internal registration (dynamicObjectsToAdd, position
// index, world notification, persistence, client rendering).
//
// OwnershipSign item type: 301
//
// Commands (admin only, handled in hook_commands.c):
//   /claim <ownerName> [radius]   — place sign at admin's position
//   /unclaim                       — remove sign at admin's position
// =============================================================================

#define OWNERSHIP_SIGN_ITEM_TYPE 301

// Create an InventoryItem of the given type
static id CreateInventoryItem(int itemType) {
    Class cls = objc_getClass("InventoryItem");
    if (!cls) return nil;

    SEL allocSel = sel_registerName("alloc");
    id obj = ((id (*)(id, SEL))objc_msg_lookup((id)cls, allocSel))((id)cls, allocSel);
    if (!obj) return nil;

    SEL initSel = sel_registerName("initWithType:dataA:dataB:subItems:dynamicObjectSaveDict:");
    IMP imp = objc_msg_lookup(obj, initSel);
    if (!imp) return nil;

    // initWithType:(int)type dataA:(uint16)0 dataB:(uint16)0 subItems:nil dynamicObjectSaveDict:nil
    return ((id (*)(id, SEL, int, unsigned short, unsigned short, id, id))imp)(
        obj, initSel, itemType, 0, 0, nil, nil);
}

bool PlaceOwnershipSign(id dynWorld, int x, int y, const char *ownerName,
                        const char *ownerClientId, int radius) {
    if (!dynWorld || !ownerName || !ownerClientId) return false;
    if (radius < 1) radius = 1;
    if (radius > 61) radius = 61;

    // Create the ownership sign inventory item
    id item = CreateInventoryItem(OWNERSHIP_SIGN_ITEM_TYPE);
    if (!item) {
        fprintf(stderr, "[Claims] Failed to create InventoryItem for ownership sign.\n");
        return false;
    }

    // Build saveDict with sign text
    Class dictClass = objc_getClass("NSMutableDictionary");
    SEL allocSel = sel_registerName("alloc");
    SEL initSel = sel_registerName("init");
    id dict = ((id (*)(id, SEL))objc_msg_lookup((id)dictClass, allocSel))((id)dictClass, allocSel);
    dict = ((id (*)(id, SEL))objc_msg_lookup(dict, initSel))(dict, initSel);

    // Set sign text (displayed on the sign)
    char signText[256];
    snprintf(signText, 256, "%s's Land", ownerName);
    SEL setSel = sel_registerName("setObject:forKey:");
    ((void (*)(id, SEL, id, id))objc_msg_lookup(dict, setSel))(
        dict, setSel, NSStr(signText), NSStr("text"));

    // Pack position as intpair (x in low 32 bits, y in high 32 bits)
    long long pos = ((long long)(unsigned int)y << 32) | (long long)(unsigned int)x;

    // Call DynamicWorld::interactionObjectPlacedAtPosition:withItem:flipped:saveDict:placedByClient:clientName:
    SEL placeSel = sel_registerName(
        "interactionObjectPlacedAtPosition:withItem:flipped:saveDict:placedByClient:clientName:");
    IMP placeImp = objc_msg_lookup(dynWorld, placeSel);
    if (!placeImp) {
        fprintf(stderr, "[Claims] interactionObjectPlacedAtPosition: not found.\n");
        return false;
    }

    id sign = ((id (*)(id, SEL, long long, id, BOOL, id, id, id))placeImp)(
        dynWorld, placeSel, pos, item, 0, dict, NSStr("serverclaimbot"), NSStr(ownerName));

    if (!sign) {
        fprintf(stderr, "[Claims] Failed to place ownership sign at (%d,%d).\n", x, y);
        return false;
    }

    // Set land owner
    SEL setOwnerSel = sel_registerName("setLandOwnerID:name:");
    IMP setOwnerImp = objc_msg_lookup(sign, setOwnerSel);
    if (setOwnerImp) {
        ((void (*)(id, SEL, id, id))setOwnerImp)(
            sign, setOwnerSel, NSStr(ownerClientId), NSStr(ownerName));
    }

    // Set radius
    SEL setWidthSel = sel_registerName("setWidthRadius:");
    IMP setWidthImp = objc_msg_lookup(sign, setWidthSel);
    if (setWidthImp) {
        ((void (*)(id, SEL, int))setWidthImp)(sign, setWidthSel, radius);
    }

    SEL setHeightSel = sel_registerName("setHeightRadius:");
    IMP setHeightImp = objc_msg_lookup(sign, setHeightSel);
    if (setHeightImp) {
        ((void (*)(id, SEL, int))setHeightImp)(sign, setHeightSel, radius);
    }

    // Notify world of ownership sign placement
    // Get world from dynWorld
    Ivar worldIv = class_getInstanceVariable(object_getClass(dynWorld), "world");
    if (worldIv) {
        id world = *(id *)((char *)dynWorld + ivar_getOffset(worldIv));
        if (world) {
            SEL notifySel = sel_registerName(
                "ownershipSignWasPlacedOrChangedAtPos:withLandOwner:widthRadius:heightRadius:wasRemoved:");
            IMP notifyImp = objc_msg_lookup(world, notifySel);
            if (notifyImp) {
                ((void (*)(id, SEL, long long, id, int, int, BOOL))notifyImp)(
                    world, notifySel, pos, NSStr(ownerClientId), radius, radius, 0);
            }
        }
    }

    fprintf(stderr, "[Claims] Ownership sign placed at (%d,%d) owner=%s radius=%d.\n",
            x, y, ownerName, radius);
    return true;
}

bool RemoveOwnershipSign(id dynWorld, int x, int y) {
    if (!dynWorld) return false;

    // Find the object at this position — look for an InteractionObject of type 8 (OwnershipSign)
    SEL objAtPosSel = sel_registerName("objectOfType:atPos:");
    IMP objAtPosImp = objc_msg_lookup(dynWorld, objAtPosSel);
    if (!objAtPosImp) {
        fprintf(stderr, "[Claims] objectOfType:atPos: not found.\n");
        return false;
    }

    long long pos = ((long long)(unsigned int)y << 32) | (long long)(unsigned int)x;

    // Type 8 = InteractionObject (includes signs)
    // Try to find any interaction object at this position
    id obj = ((id (*)(id, SEL, int, long long))objAtPosImp)(dynWorld, objAtPosSel, 8, pos);
    if (!obj) {
        fprintf(stderr, "[Claims] No interaction object at (%d,%d).\n", x, y);
        return false;
    }

    // Verify it's an OwnershipSign
    Class ownershipClass = objc_getClass("OwnershipSign");
    if (!ownershipClass) return false;

    SEL isKindSel = sel_registerName("isKindOfClass:");
    IMP isKindImp = objc_msg_lookup(obj, isKindSel);
    if (!isKindImp) return false;
    BOOL isOwnership = ((BOOL (*)(id, SEL, Class))isKindImp)(obj, isKindSel, ownershipClass);
    if (!isOwnership) {
        fprintf(stderr, "[Claims] Object at (%d,%d) is not an OwnershipSign.\n", x, y);
        return false;
    }

    // Notify world of removal before removing
    Ivar worldIv = class_getInstanceVariable(object_getClass(dynWorld), "world");
    if (worldIv) {
        id world = *(id *)((char *)dynWorld + ivar_getOffset(worldIv));
        if (world) {
            // Get current owner ID and radius for notification
            id ownerId = *(id *)((char *)obj + 0xd0);
            int wRadius = *(int *)((char *)obj + 0xe0);
            int hRadius = *(int *)((char *)obj + 0xe4);

            SEL notifySel = sel_registerName(
                "ownershipSignWasPlacedOrChangedAtPos:withLandOwner:widthRadius:heightRadius:wasRemoved:");
            IMP notifyImp = objc_msg_lookup(world, notifySel);
            if (notifyImp) {
                ((void (*)(id, SEL, long long, id, int, int, BOOL))notifyImp)(
                    world, notifySel, pos, ownerId, wRadius, hRadius, 1);
            }
        }
    }

    // Mark for removal
    *(char *)((char *)obj + 0x48) = 1;  // needsRemoved = YES

    fprintf(stderr, "[Claims] Ownership sign removed at (%d,%d).\n", x, y);
    return true;
}
