# Startup Guide

Step-by-step walkthrough for hosting a Blockheads server with all tools running. Covers a single world setup and how to add more worlds.

---

## What you're setting up

Four things have to run for each world:

```
Game Server  ←→  Java Proxy  →  Node.js Bot  →  Python Daemon (auto)
(UDP :15151)    (UDP :15153)    (your config)    (LMDB reads/writes)
```

The bot spawns the Python daemon automatically. You manage the other three.

---

## Step 1 — Machine prep

You need a 64-bit Linux machine. Install everything once:

```bash
# Node.js 18+
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Java 21 (exactly 21 — proxy uses preview features)
sudo apt install -y openjdk-21-jdk

# Python 3 (must be 64-bit)
# Verify: python3 -c "import struct; print(struct.calcsize('P')*8)"  → must print 64
sudo apt install -y python3 python3-pip

# GNUstep (for the LD_PRELOAD item injection hook)
sudo apt install -y gobjc gnustep-devel

# PM2 (process manager — keeps everything alive across reboots)
sudo npm install -g pm2
```

---

## Step 2 — Clone and build (once, shared by all worlds)

```bash
cd /opt
git clone https://github.com/saadkhairullah/blockheads-server-tools.git bhs
cd bhs

# Build the bot
cd bot && npm install && npm run build && cd ..

# Proxy — no build step needed, Gradle runs it directly
# (For production/PM2 only: cd proxy && ./gradlew :interceptor:installDist && cd ..)

# Install Python dependencies
cd tools && pip install -r requirements.txt && cd ..

# Build the LD_PRELOAD item injection library
gcc -shared -fPIC -o blockheads_give.so blockheads_give.c -lobjc -ldl -lpthread
```

The compiled output lives in `/opt/bhs`. All worlds share these binaries — you only build once.

---

## Step 3 — Create a world directory

For each world you host, create an isolated directory:

```bash
mkdir -p /worlds/my-world/data
```

Your Blockheads save is typically at:

```
~/.local/share/TheBlockheads/saves/<YOUR_WORLD_UUID>/
```

You can point the config at that path directly — no need to move anything.

---

## Step 4 — Configure the world

```bash
cp /opt/bhs/config/config.example.json /worlds/my-world/config.json
```

Open `/worlds/my-world/config.json` and fill in the fields specific to your world:

```json
{
  "server": {
    "user": "YourUsername",
    "pass": "YourServerPassword",
    "worldName": "My World",
    "worldId": "abc-1234-your-uuid-here"
  },
  "paths": {
    "worldSave": "/home/you/.local/share/TheBlockheads/saves/abc-1234-your-uuid-here/",
    "dataDir":   "/worlds/my-world/data",
    "questData": "/worlds/my-world/quests.json",
    "serverLog": "/worlds/my-world/data/blockheads.log",
    "inputPipe": "/worlds/my-world/data/blockheads_input",
    "proxyCommandSock": "/tmp/bh-commands-my-world.sock",
    "wmSock":    "/tmp/bh-wm-my-world.sock",
    "python":    "python3",
    "wildLocations": "/opt/bhs/tools/wild_locations.py"
  }
}
```

The `worldId` is the UUID folder name inside your saves directory. Run `ls ~/.local/share/TheBlockheads/saves/` to find it.

Also create the named pipe (FIFO) — the game server reads bot commands from here via `tail -f`. This must be a real FIFO, not a regular file:

```bash
mkfifo /worlds/my-world/data/blockheads_input
```

Every world needs its own pipe at a unique path. If two game servers shared one pipe, they would each consume commands meant for the other — kicks, gives, and chat messages would go to the wrong world. Same applies to `blockheads.log`: each game server must write to its own log file, and each bot must tail only its own world's log.

---

## Step 5 — Make yourself admin

```bash
echo "YOURUSERNAME" >> /path/to/worldSave/adminlist.txt
```

Uppercase. One name per line. The bot watches this file live — no restart needed when you add or remove someone.

---

## Step 6 — Set up your quests

```bash
cp /opt/bhs/config/quest-data.json /worlds/my-world/quests.json
nano /worlds/my-world/quests.json
```

No rebuild needed — just edit the JSON and restart the bot. See the **Quests** section in the README for all available fields and types.

---

## Step 7 — Choose your extensions

Open `bot/src/mac.ts` and edit the `.use()` chain to include only the features you want:

```typescript
new BlockheadsBot(config)
  .use('server-messages')   // join/leave announcements
  .use(VirtualBank)         // token economy
  .use(ActivityMonitor)     // coords tracking + forbidden item removal
  .use(QuestSystem)         // quest chain
  .use(ShopSystem)          // /buy /shop
  .use(TeleportSystem)      // /wild /tpa /spawn
  .use(JobSystem)           // /apply /hire /fire
  .use('whisper')           // /whisper
  .use('commands-help')     // /help
  .start()
```

What each extension does and when you'd skip it:

| Extension | What it does | Skip it if... |
|-----------|-------------|---------------|
| `server-messages` | Sends join/leave announcements in chat | You want a silent server |
| `VirtualBank` | Token economy — `/balance`, `/daily`, `/pay`, `/cf` | You don't want an economy. Removing it also forces you to remove Shop, Teleport, and Jobs. |
| `ActivityMonitor` | Real-time coord tracking, forbidden item detection and removal | You trust all players and don't need coords. Removing it also forces you to remove QuestSystem, Shop, and Teleport. |
| `QuestSystem` | Quest chain — `/quest`, progress tracking, rewards | You don't want quests |
| `ShopSystem` | `/buy`, `/shop` — item purchases with tokens | You don't want a shop |
| `TeleportSystem` | `/wild`, `/tpa`, `/tpaccept`, `/tpdeny`, `/spawn` | Small map where teleport would be too powerful |
| `JobSystem` | `/apply`, `/hire`, `/fire`, `/rep` — employment and daily pay | You don't need a job system |
| `whisper` | `/whisper <player> <msg>` — private messages | You don't want private messaging |
| `commands-help` | `/help` command listing all commands | You'd rather players discover commands themselves |

**Dependency rules:** extensions that depend on each other must all be included or all excluded together:

- Removing `VirtualBank` → must also remove `ShopSystem`, `TeleportSystem`, `JobSystem`
- Removing `ActivityMonitor` → must also remove `QuestSystem`, `ShopSystem`, `TeleportSystem`

The bot enforces this at startup and will give you a clear error if something is missing:

```
Error: Extension "shop-system" requires "virtual-bank" but it is not registered.
Registered: [activity-monitor, quest-system]
```

After editing `mac.ts`, rebuild:

```bash
cd /opt/bhs/bot && npm run build
```

---

## Step 8 — Start the game server

```bash
nohup bash -c '
  tail -f /worlds/my-world/data/blockheads_input | LD_PRELOAD=/opt/bhs/blockheads_give.so /path/to/blockheads_server171 -o abc-1234-your-uuid-here -s 67 -m 32 --owner YourUsername --no-exit 2>&1 | tee /worlds/my-world/data/blockheads.log' &
```

What each piece does:

| Part | Purpose |
|------|---------|
| `tail -f .../blockheads_input` | Bot writes kick/chat/give commands here; piped into server stdin |
| `LD_PRELOAD=.../blockheads_give.so` | Adds `/give-id` to stdin so the bot can give items to players, also adds trade  portal exploits |
| `-o abc-1234` | Tells the server which world UUID to load |
| `tee .../blockheads.log` | Bot tails this file to detect joins, leaves, and chat |
| `-s 67` | Save Delay (67 = large) |
| `-m 32` | Max players |

---

## Step 9 — Start the proxy

The proxy intercepts all game UDP traffic and streams events to the bot:

```bash
cd /opt/bhs/proxy && ./gradlew :interceptor:run --args='-P 15153 -S 15151 --event-socket /tmp/bh-events-my-world.sock --command-socket /tmp/bh-commands-my-world.sock'
```

For production (PM2/systemd), build a standalone launcher first and use that instead:

```bash
cd /opt/bhs/proxy && ./gradlew :interceptor:installDist
# then run:
/opt/bhs/proxy/interceptor/build/install/interceptor/bin/interceptor \
  -P 15153 -S 15151 \
  --event-socket /tmp/bh-events-my-world.sock \
  --command-socket /tmp/bh-commands-my-world.sock
```

- `-P 15153` — the port **players connect to**
- `-S 15151` — the port the actual game server is on

Players must connect to 15153 (not 15151). If you want to keep the original port transparent, redirect it with iptables:

```bash
sudo iptables -t nat -A PREROUTING -p udp --dport 15151 -j REDIRECT --to-port 15153
```

---

## Step 10 — Start the bot

```bash
cd /opt/bhs/bot && node build/mac.js
```

On startup the bot will:

1. Validate all extension dependencies — fails fast with a clear error if something is wrong
2. Spawn the Python LMDB daemon automatically (connects to `/tmp/bh-wm-my-world.sock`)
3. Connect to the proxy's UDS event socket (`/tmp/bh-events-my-world.sock`) — receives game events
4. Connect to the proxy's UDS command socket (`/tmp/bh-commands-my-world.sock`) — sends private messages
5. Start watching `blockheads.log` for chat and join/leave events
6. Print `Bot started.`

---

## Step 11 — Put it all under PM2

```bash
# Register the bot with PM2
pm2 start /opt/bhs/bot/build/mac.js \
  --name "bot-my-world" \
  --cwd /opt/bhs/bot

# Save the process list and enable startup on reboot
pm2 save
pm2 startup   # follow the printed command to install the init script
```

For the proxy, build the standalone launcher first (only needed once), then create a wrapper script so PM2 can manage it:

```bash
# One-time build (required before PM2 can use the launcher)
cd /opt/bhs/proxy && ./gradlew :interceptor:installDist && cd -

cat > /worlds/my-world/start-proxy.sh << 'EOF'
#!/bin/bash
exec /opt/bhs/proxy/interceptor/build/install/interceptor/bin/interceptor \
  -P 15153 -S 15151 \
  --event-socket /tmp/bh-events-my-world.sock \
  --command-socket /tmp/bh-commands-my-world.sock
EOF
chmod +x /worlds/my-world/start-proxy.sh

pm2 start /worlds/my-world/start-proxy.sh --name "proxy-my-world"
pm2 save
```

---

## Adding a second world

Repeat steps 3–11 with different values for everything that must be unique:

| Thing | World 1 | World 2 |
|-------|---------|---------|
| World UUID | `abc-123` | `def-456` |
| Data directory | `/worlds/world-1/data` | `/worlds/world-2/data` |
| Input pipe (FIFO) | `/worlds/world-1/data/blockheads_input` | `/worlds/world-2/data/blockheads_input` |
| Server log | `/worlds/world-1/data/blockheads.log` | `/worlds/world-2/data/blockheads.log` |
| Game server port | `15151` | `15161` |
| Proxy port (players connect here) | `15153` | `15163` |
| LMDB daemon socket | `/tmp/bh-wm-1.sock` | `/tmp/bh-wm-2.sock` |
| Proxy event socket | `/tmp/bh-events-1.sock` | `/tmp/bh-events-2.sock` |
| Proxy command socket | `/tmp/bh-commands-1.sock` | `/tmp/bh-commands-2.sock` |
| PM2 names | `bot-world-1`, `proxy-world-1` | `bot-world-2`, `proxy-world-2` |

Remember to create the input pipe for each new world before starting its game server:

```bash
mkfifo /worlds/world-2/data/blockheads_input
```

The binaries in `/opt/bhs` are shared — no rebuild needed for additional worlds.

Each world runs its own independent Node.js process. They do not share any state.

---

## Quick sanity checks

```bash
# Is the bot connected to the proxy?
pm2 logs bot-my-world | grep "\[UDS\]"
# Should see: [UDS] Connected to proxy

# Is the Python daemon socket alive?
ls /tmp/bh-wm-my-world.sock
# Should exist while the bot is running

# Can Python open the LMDB directly?
python3 /opt/bhs/tools/world_manager.py \
  --save-path /path/to/worldSave list-blockheads

# Test item injection manually (give item 88 = diamond to blockhead ID 12345)
echo "/give-id 12345 88 1" > /worlds/my-world/data/blockheads_input

# Generate a stack dump if the bot seems frozen
kill -USR2 $(pm2 pid bot-my-world)
cat /worlds/my-world/data/node-stack-dump.txt
```
