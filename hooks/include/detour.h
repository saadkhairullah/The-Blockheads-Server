#ifndef DETOUR_H
#define DETOUR_H

#include "bh_common.h"

// Write a 13-byte absolute jump (movabs $addr, %r11; jmp *%r11)
void write_detour_jmp(unsigned char *buf, void *target);

// Install binary detour: overwrites function entry to jump to hook.
// stolen_len = bytes at function entry to relocate (>= 13, on instruction boundary).
// Returns trampoline pointer for calling the original, or NULL on failure.
void *install_detour(void *func, void *hook, int stolen_len);

// Patch a single byte at an address (with mprotect). Returns true on success.
bool patch_byte(void *addr, unsigned char value);

// Patch N bytes at an address (with mprotect). Returns true on success.
bool patch_bytes(void *addr, const unsigned char *bytes, int len);

#endif // DETOUR_H
