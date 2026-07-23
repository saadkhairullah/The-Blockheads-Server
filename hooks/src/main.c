#include "bh_common.h"
#include "hooks.h"
#include "hook_config.h"
#include "hook_tick.h"
#include "hook_arena.h"
#include "poison.h"
#include <pthread.h>

#define SERVER_CLASS "BHServer"

// --- GLOBALS ---
CmdFunc  Real_HandleCmd = NULL;
ChatFunc Real_SendChat  = NULL;

static void* InitHook(void* arg) {
    sleep(1);  // Wait for ObjC runtime to finish loading

    // Load config first — all other hooks read from it
    const HookConfig *cfg = LoadHookConfig(NULL);

    // Binary patches (order matters: network first for stability)
    if (!cfg || cfg->enableNetwork)  InitNetworkHooks();
    if (!cfg || cfg->enableBoss)     InitCaveTrollHooks();

    // ObjC method hooks (always — command dispatch is core infrastructure)
    Class clsServer = objc_getClass(SERVER_CLASS);
    if (clsServer) {
        Method mCmd = class_getInstanceMethod(clsServer, sel_registerName("handleCommand:issueClient:"));
        Real_HandleCmd = (CmdFunc)method_getImplementation(mCmd);
        method_setImplementation(mCmd, (IMP)Hook_HandleCmd);

        Method mChat = class_getInstanceMethod(clsServer, sel_registerName("sendChatMessage:displayNotification:sendToClients:"));
        Real_SendChat = (ChatFunc)method_getImplementation(mChat);

        fprintf(stderr, "[Hooks] Command hooks installed.\n");
    } else {
        fprintf(stderr, "[Hooks] Error: BHServer class not found.\n");
    }

    // Feature hooks — only init if enabled in config
    if (!cfg || cfg->enableTrade)    InitTradeHooks();
    if (!cfg || cfg->enableGodmode)  InitGodModeHooks();
    if (!cfg || cfg->enablePoison)   InitPoison();
    if (!cfg || cfg->enableArena)    InitArenaSystem();
    InitTickHook();  // always (central dispatcher, subsystems check their own flags)

    fprintf(stderr, "[Hooks] All hooks initialized.\n");
    return NULL;
}

__attribute__((constructor)) static void Entry(void) {
    pthread_t t;
    pthread_create(&t, NULL, InitHook, NULL);
}
