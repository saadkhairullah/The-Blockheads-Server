#include "bh_common.h"
#include "objc_helpers.h"
#include "hook_config.h"
#include "poison.h"
#include "hook_arena.h"
#include "hook_tick.h"

// =============================================================================
// DynamicWorld Tick Hook
//
// Hooks DynamicWorld::update:accurateDT:isSimulation: to provide a central
// tick dispatcher. All subsystems that need periodic updates register here
// instead of piggybacking on boss troll updates.
//
// Dispatches:
//   - ProcessPoisonTicks() — poison DOT
//   - UpdateDuelSystem()   — duel countdown/timeout/rejoin
//   - UpdateArena()        — wave spawning/tracking (future)
// =============================================================================

typedef void (*DynWorldUpdateFunc)(id, SEL, float, float, BOOL);
static DynWorldUpdateFunc Orig_DynWorld_Update = NULL;

static void Hook_DynWorld_Update(id self, SEL _cmd, float dt, float accurateDT,
                                 BOOL isSimulation) {
    // Call original — all vanilla updates run first
    Orig_DynWorld_Update(self, _cmd, dt, accurateDT, isSimulation);

    // Skip custom logic during simulation (fast-forward)
    if (isSimulation) return;

    const HookConfig *cfg = GetHookConfig();

    // --- Poison DOT ---
    if (!cfg || cfg->enablePoison) ProcessPoisonTicks(self);

    // --- Mob Arena ---
    if (!cfg || cfg->enableArena) UpdateArena(self, dt);
}

void InitTickHook(void) {
    Class dynWorldClass = objc_getClass("DynamicWorld");
    if (!dynWorldClass) {
        fprintf(stderr, "[Tick] DynamicWorld class not found.\n");
        return;
    }

    SEL sel = sel_registerName("update:accurateDT:isSimulation:");
    Method m = class_getInstanceMethod(dynWorldClass, sel);
    if (!m) {
        fprintf(stderr, "[Tick] DynamicWorld update:accurateDT:isSimulation: not found.\n");
        return;
    }

    Orig_DynWorld_Update = (DynWorldUpdateFunc)method_getImplementation(m);
    method_setImplementation(m, (IMP)Hook_DynWorld_Update);
    fprintf(stderr, "[Tick] DynamicWorld update: hooked (central tick dispatcher).\n");
}
