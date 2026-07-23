#include "objc_helpers.h"

id AutoreleasePool(void) {
    Class cls = objc_getClass("NSAutoreleasePool");
    SEL sA = sel_registerName("alloc");
    SEL sI = sel_registerName("init");
    AllocFunc fA = (AllocFunc)method_getImplementation(class_getClassMethod(cls, sA));
    InitFunc fI = (InitFunc)method_getImplementation(class_getInstanceMethod(cls, sI));
    return fI(fA((id)cls, sA), sI);
}

void DrainPool(id pool) {
    if (!pool) return;
    SEL s = sel_registerName("drain");
    VoidFunc f = (VoidFunc)method_getImplementation(class_getInstanceMethod(object_getClass(pool), s));
    f(pool, s);
}

id NSStr(const char* txt) {
    if (!txt) return nil;
    Class cls = objc_getClass("NSString");
    SEL s = sel_registerName("stringWithUTF8String:");
    StrFunc f = (StrFunc)method_getImplementation(class_getClassMethod(cls, s));
    return f ? f((id)cls, s, txt) : nil;
}

const char* ToCStr(id str) {
    if (!str) return "";
    SEL s = sel_registerName("UTF8String");
    Utf8Func f = (Utf8Func)method_getImplementation(class_getInstanceMethod(object_getClass(str), s));
    return f ? f(str, s) : "";
}

void SendChat(id server, const char* msg) {
    if (server && Real_SendChat) {
        Real_SendChat(server, sel_registerName("sendChatMessage:displayNotification:sendToClients:"),
                      NSStr(msg), true, nil);
    }
}
