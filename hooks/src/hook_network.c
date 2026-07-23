#include "bh_common.h"
#include "detour.h"

// --- pollNetEvents crash fix ---
// BHNetServerMatch::pollNetEvents calls exit(0) on ANY NSRangeException.
// Patch: redirect exit(0) call to the function's return epilogue.

void InitNetworkHooks(void) {
    unsigned char *exit_call = (unsigned char *)0x4fb3e4;

    if (exit_call[0] != 0xe8 || exit_call[1] != 0x17 || exit_call[2] != 0xed) {
        fprintf(stderr, "[Network] pollNetEvents exit() bytes mismatch — skipping\n");
        return;
    }

    // Replace: call exit → jmp 0x4fb32b (return epilogue)
    // rel32 = 0x4fb32b - (0x4fb3e4 + 5) = 0xFFFFFF42
    unsigned char patch[] = { 0xe9, 0x42, 0xff, 0xff, 0xff };
    if (patch_bytes(exit_call, patch, 5)) {
        fprintf(stderr, "[Network] pollNetEvents crash-on-exception patched.\n");
    } else {
        fprintf(stderr, "[Network] pollNetEvents patch failed.\n");
    }
}
