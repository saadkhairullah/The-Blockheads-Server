#ifndef BH_COMMON_H
#define BH_COMMON_H

#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <dlfcn.h>
#include <stdbool.h>
#include <stdint.h>
#include <ctype.h>
#include <sys/mman.h>
#include <objc/runtime.h>
#include <objc/message.h>

// --- IMP TYPES (ObjC function pointer signatures) ---
typedef id (*CmdFunc)(id, SEL, id, id);
typedef id (*AllocFunc)(id, SEL);
typedef id (*InitFunc)(id, SEL);
typedef void (*VoidFunc)(id, SEL);
typedef id (*StrFunc)(id, SEL, const char*);
typedef const char* (*Utf8Func)(id, SEL);
typedef int (*IntFunc)(id, SEL);
typedef id (*IdxFunc)(id, SEL, int);
typedef id (*GetterFunc)(id, SEL);
typedef long (*CompFunc)(id, SEL, id);
typedef id (*ByUniqueIdFunc)(id, SEL, unsigned long long);
typedef void (*ChatFunc)(id, SEL, id, BOOL, id);
typedef id (*UpdateNetDataFunc)(id, SEL, id);
typedef void (*UpdatePositionFunc)(id, SEL, long long);
typedef id (*SpawnFunc)(id, SEL, long long, int, int, int, id, id, BOOL, BOOL, id);

// --- GLOBALS (defined in main.c) ---
extern CmdFunc  Real_HandleCmd;
extern ChatFunc Real_SendChat;

#endif // BH_COMMON_H
