#ifndef OBJC_HELPERS_H
#define OBJC_HELPERS_H

#include "bh_common.h"

// Create and drain autorelease pools
id   AutoreleasePool(void);
void DrainPool(id pool);

// NSString ↔ C string conversions
id          NSStr(const char* txt);
const char* ToCStr(id str);

// Send a chat message through the server
void SendChat(id server, const char* msg);

#endif // OBJC_HELPERS_H
