CC      = gcc
CFLAGS  = -shared -fPIC -Wall -Wextra -Wno-unused-parameter -Wno-cast-function-type -I include -I lib
LDFLAGS = -lpthread -lobjc
TARGET  = libblockheads_hooks.so
INSTALL = $(HOME)/blockheads_give.so

SRCS = lib/cJSON.c \
       src/main.c \
       src/objc_helpers.c \
       src/detour.c \
       src/entity.c \
       src/admin.c \
       src/hook_config.c \
       src/hook_commands.c \
       src/hook_cavetroll.c \
       src/hook_network.c \
       src/hook_trade.c \
       src/hook_godmode.c \
       src/hook_poison.c \
       src/hook_tick.c \
       src/hook_arena.c \
       src/hook_claims.c

.PHONY: all clean install

all: $(TARGET)

$(TARGET): $(SRCS) include/*.h
	$(CC) $(CFLAGS) -o $@ $(SRCS) $(LDFLAGS)
	@echo "Built $(TARGET)"

install: $(TARGET)
	cp $(TARGET) $(INSTALL)
	@echo "Installed to $(INSTALL)"

clean:
	rm -f $(TARGET)
