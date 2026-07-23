#include "detour.h"

void write_detour_jmp(unsigned char *buf, void *target) {
    buf[0] = 0x49; buf[1] = 0xbb;  // movabs $imm64, %r11
    memcpy(buf + 2, &target, 8);
    buf[10] = 0x41; buf[11] = 0xff; buf[12] = 0xe3;  // jmp *%r11
}

void *install_detour(void *func, void *hook, int stolen_len) {
    if (stolen_len < 13) return NULL;

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
    for (int i = 13; i < stolen_len; i++)
        ((unsigned char *)func)[i] = 0x90;
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);

    return tramp;
}

bool patch_byte(void *addr, unsigned char value) {
    uintptr_t page = (uintptr_t)addr & ~0xFFF;
    if (mprotect((void *)page, 0x2000, PROT_READ | PROT_WRITE | PROT_EXEC) != 0)
        return false;
    *(unsigned char *)addr = value;
    mprotect((void *)page, 0x2000, PROT_READ | PROT_EXEC);
    return true;
}

bool patch_bytes(void *addr, const unsigned char *bytes, int len) {
    uintptr_t page = (uintptr_t)addr & ~0xFFF;
    // Handle case where patch spans a page boundary
    uintptr_t end_page = ((uintptr_t)addr + len - 1) & ~0xFFF;
    size_t protect_len = (end_page - page) + 0x1000;
    if (mprotect((void *)page, protect_len, PROT_READ | PROT_WRITE | PROT_EXEC) != 0)
        return false;
    memcpy(addr, bytes, len);
    mprotect((void *)page, protect_len, PROT_READ | PROT_EXEC);
    return true;
}
