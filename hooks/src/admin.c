#include "admin.h"

// Set BH_ADMIN_LIST_PATH env var in production — this fallback is not valid.
#define DEFAULT_ADMIN_LIST_PATH "/etc/blockheads/adminlist.txt"

bool IsAdmin(const char* name) {
    if (!name || !*name) return false;

    const char* path = getenv("BH_ADMIN_LIST_PATH");
    if (!path) path = DEFAULT_ADMIN_LIST_PATH;

    FILE* f = fopen(path, "r");
    if (!f) return false;

    char line[256];
    bool firstLine = true;
    bool found = false;
    while (fgets(line, sizeof(line), f)) {
        if (firstLine) { firstLine = false; continue; }  // skip header
        int len = (int)strlen(line);
        while (len > 0 && (line[len-1] == '\n' || line[len-1] == '\r' || line[len-1] == ' '))
            line[--len] = '\0';
        if (len == 0) continue;
        if (strcasecmp(line, name) == 0) { found = true; break; }
    }
    fclose(f);
    return found;
}
