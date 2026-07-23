#ifndef HOOKS_H
#define HOOKS_H

// Hook init functions — called from main.c during server startup
void InitCaveTrollHooks(void);
void InitNetworkHooks(void);
void InitTradeHooks(void);
void InitGodModeHooks(void);
void InitTickHook(void);
void InitArenaSystem(void);

// Command handler — registered as ObjC method replacement
id Hook_HandleCmd(id self, SEL _cmd, id cmdStr, id client);

#endif // HOOKS_H
