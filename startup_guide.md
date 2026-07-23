# Startup Guide

**Docker is the recommended and supported way to run Blockheads Server Tools.** See the [README](README.md) for the full Docker setup guide.

The quick version:

```bash
git clone https://github.com/saadkhairullah/blockheads-server-tools.git
cd blockheads-server-tools/docker

cp .env.example .env
# Fill in BH_WORLD_ID, BH_SERVER_USER, BH_SERVER_PASS, BH_GNUSTEP_PATH

sudo docker compose build
sudo docker compose up -d
```

## Configuration

On first run the container copies the bundled `config.example.json` to `data/config.json` — the
single source of truth for both the bot and the C hooks. Edit `data/config.json` to change shop
items, jobs, economy, which C hooks (`hooks.*.enabled`) are on, or which bot extensions
(`extensions.*`) load, then `sudo docker compose restart`. No rebuild needed.

The default deploy runs a minimal hook set: `trade` (price protection), `network` (crash-fix),
and `claims` are on; `boss`, `poison`, `godmode`, `arena`, and `duel` ship disabled. `/give`
always works.

## Viewing logs

```bash
tail -f data/logs/bot.log          # bot activity
tail -f data/logs/blockheads.log   # game server
tail -f data/logs/proxy.log        # Java proxy
```

## Sending commands

```bash
echo "/kick PLAYERNAME" >> blockheads-server-tools/data/blockheads_input
```

## Updating

```bash
git pull
sudo docker compose build
sudo docker compose up -d
```

## Multiple worlds

```bash
./add-server.sh --name "PvP Arena" --port 15153 --world-id "abc-123" --owner "YourUsername"
# Follow the printed instructions to add the service to docker-compose.multi.yml
sudo docker compose -f docker-compose.multi.yml up -d
```
