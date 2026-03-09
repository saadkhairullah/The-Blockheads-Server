#!/usr/bin/env python3
"""
Complete Blockheads World Manager:
- Read player inventories
- Read placed chests in the world
- Edit and save to new folder using GameSave

Sub-modules:
  item_utils.py         — Item creation and basket/chest slot manipulation
  world_settings.py     — worldv2 read/write (expert mode, portal level)
  inventory_ops.py      — Inventory queries (counts, space checks, clear)
  targeted_lmdb_ops.py  — Targeted LMDB writes (give, take, teleport, quest items)
  daemon.py             — Persistent daemon mode (JSON over stdin/stdout)
"""

import json

from gameSave import GameSave
from item import Item
from item_utils import get_basket_slots, get_slot_item, get_item_name
from world_settings import get_worldv2
from inventory_ops import (
    find_player_uuid_for_blockhead,
    list_blockheads_for_player,
    get_inventory_counts,
    get_all_blockhead_inventory_counts,
)
from targeted_lmdb_ops import (
    give_item_to_blockhead,
    take_item_from_blockhead,
    teleport_blockhead_targeted,
    apply_quest_items_targeted,
    get_blockhead_position,
    list_blockheads_with_names,
)
from daemon import run_daemon

SAVE_PATH = None
OUTPUT_PATH = None


# ---------------------------------------------------------------------------
# Display utilities (CLI only)
# ---------------------------------------------------------------------------

def print_container_contents(item_obj, indent=6):
    """Print basket/chest contents."""
    spaces = ' ' * indent

    try:
        storage = get_basket_slots(item_obj)

        # Basket (4 slots)
        if storage is not None:
            occupied = sum(1 for s in storage if s and hasattr(s, 'count') and s.count > 0)
            print(f"{spaces}-- Basket ({occupied}/4 slots)")

            for slot_idx in range(4):
                slot_data = storage[3 - slot_idx]
                if slot_data and hasattr(slot_data, 'count') and slot_data.count > 0:
                    item_name = get_item_name(slot_data.get_id())
                    count = slot_data.get_count()

                    damage = slot_data.get_damage()
                    durability = f" [{(16000-damage)/160:.0f}%]" if 0 < damage <= 16000 else ""

                    print(f"{spaces}   Slot {slot_idx}: {item_name}{' x'+str(count) if count > 1 else ''}{durability}")

        # Chest (16 slots) doesnt really work yet
        else:
            if not item_obj.items[0].has_extra:
                print(f"{spaces}-- Empty")
                return
            extra = item_obj.items[0]._zip._data[0]
            if hasattr(extra, '_data'):
                extra = extra._data
            if not isinstance(extra, dict) or 'saveItemSlots' not in extra:
                print(f"{spaces}-- Empty")
                return
            storage = extra['saveItemSlots']
            occupied = 0
            for row in storage:
                if isinstance(row, list):
                    for cell in row:
                        if cell and hasattr(cell, 'count') and cell.count > 0:
                            occupied += 1
            print(f"{spaces}-- Chest ({occupied}/16 slots)")

            for row_idx, row in enumerate(storage):
                if not isinstance(row, list):
                    continue
                for col_idx in range(len(row)):
                    cell = row[3 - col_idx]
                    if cell and hasattr(cell, 'count') and cell.count > 0:
                        item_name = get_item_name(cell.get_id())
                        count = cell.get_count()

                        damage = cell.get_damage()
                        durability = f" [{(16000-damage)/160:.0f}%]" if 0 < damage <= 16000 else ""

                        print(f"{spaces}   Slot {row_idx*4+col_idx}: {item_name}{' x'+str(count) if count > 1 else ''}{durability}")

    except Exception as e:
        print(f"{spaces}-- Error: {e}")

# just a test script that uses the gs path
def read_all_player_inventories(gs):
    """Read all player inventories using GameSave."""
    print("\n" + "="*80)
    print("READING PLAYER INVENTORIES")
    print("="*80)

    main_db = gs._data["world_db"][b"main"]

    player_uuids = set()

    for key in main_db.keys():
        key_str = key.decode('utf-8', errors='ignore')
        if b'_inventory' in key and b'_blockhead_' in key:
            player_uuid = key_str.split('_blockhead_')[0]
            player_uuids.add(player_uuid)

    print(f"\nFound {len(player_uuids)} players\n")

    for player_uuid in sorted(player_uuids):
        blockhead_keys = [k for k in main_db.keys()
                         if k.decode('utf-8', errors='ignore').startswith(f"{player_uuid}_blockhead_")
                         and b'_inventory' in k]

        print(f"{'~'*80}")
        print(f"PLAYER: {player_uuid}")
        print(f"Blockheads: {len(blockhead_keys)}")
        print(f"{'~'*80}")

        for key in sorted(blockhead_keys):
            key_str = key.decode('utf-8', errors='ignore')
            blockhead_uid = int(key_str.split('_blockhead_')[1].replace('_inventory', ''))

            inv_data = main_db[key]

            if hasattr(inv_data, '_data'):
                inv_data = inv_data._data
            if isinstance(inv_data, list) and len(inv_data) > 0:
                inv_data = inv_data[0]
                if hasattr(inv_data, '_data'):
                    inv_data = inv_data._data

            occupied = sum(1 for slot in inv_data if isinstance(slot, list) and len(slot) > 0)
            print(f"\n  Blockhead {blockhead_uid} - {occupied}/8 slots")

            for slot_idx, slot_data in enumerate(inv_data):
                if not isinstance(slot_data, list) or len(slot_data) == 0:
                    continue

                try:
                    item_obj = Item(slot_data)
                    item_id = item_obj.get_id()
                    item_name = get_item_name(item_id)
                    count = item_obj.get_count()

                    if item_id in [12, 1043]:  # Container
                        print(f"    Slot {slot_idx}: [{item_name}]")
                        print_container_contents(item_obj, indent=6)
                    else:
                        damage = item_obj.get_damage()
                        durability = f" [{(16000-damage)/160:.0f}%]" if 0 < damage <= 16000 else ""
                        print(f"    Slot {slot_idx}: {item_name}{' x'+str(count) if count > 1 else ''}{durability}")

                except Exception as e:
                    print(f"    Slot {slot_idx}: Error - {e}")


# ---------------------------------------------------------------------------
# Main display
# ---------------------------------------------------------------------------

def main():
    print("="*80)
    print("BLOCKHEADS WORLD MANAGER")
    print("="*80)

    print(f"\nLoading world from: {SAVE_PATH}")
    gs = GameSave.load(SAVE_PATH)

    summary = gs.get_summary()
    print(f"\nWorld: {summary.world_name}")
    print(f"Seed: {summary.seed}")
    print(f"Size: {summary.world_width_in_chunks} chunks")

    try:
        world = get_worldv2(gs)
        print(f"Expert Mode: {world.get('expertMode')}")
    except Exception as e:
        print(f"Could not read expertMode: {e}")

    read_all_player_inventories(gs)

    print("\n" + "="*80)
    print("COMPLETE")
    print("="*80)
    print("\nTo save modifications:")
    print("  1. Uncomment the modification code")
    print("  2. Uncomment gs.save(OUTPUT_PATH)")
    print("  3. Run again")
    print("\nALWAYS backup your world before saving modifications!")


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------



if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser()
    parser.add_argument("--daemon", action="store_true", help="Run in daemon mode (read JSON commands from stdin)")
    parser.add_argument("--give-item", action="store_true", help="Give a specific item by id")
    parser.add_argument("--take-item", action="store_true", help="Take a specific item by id from a blockhead")
    parser.add_argument("--list-blockheads", action="store_true", help="List blockhead ids for a player UUID")
    parser.add_argument("--list-blockheads-with-names", action="store_true", help="List blockhead ids and in-game names for a player UUID")
    parser.add_argument("--find-blockhead-owner", action="store_true", help="Find the player UUID that owns a blockhead")
    parser.add_argument("--inventory-counts", action="store_true", help="Get item counts for a blockhead")
    parser.add_argument("--player-inventory-counts", action="store_true", help="Get combined item counts for all blockheads of a player")
    parser.add_argument("--get-blockhead-position", action="store_true", help="Get a blockhead's current X/Y position")
    parser.add_argument("--teleport-blockhead", action="store_true", help="Teleport a blockhead to X/Y coordinates")
    parser.add_argument("--apply-quest-items", action="store_true", help="Atomically remove consumed items and give reward items")
    parser.add_argument("--save-path", required=True, help="Path to world save")
    parser.add_argument("--blockhead-id", type=int, help="Blockhead id")
    parser.add_argument("--player-uuid", help="Player UUID")
    parser.add_argument("--item-id", type=int, help="Item id")
    parser.add_argument("--count", type=int, default=1, help="Item count")
    parser.add_argument("--color", type=int, nargs="+", help="Dye color nibbles, 1-4 values each 0-15 (e.g. --color 3 or --color 6 6)")
    parser.add_argument("--damage", type=int, help="Damage value (0=full, 16000=broken)")
    parser.add_argument("--basket-only", action="store_true", help="Place item in a basket only (skip main inventory slots)")
    parser.add_argument("--x", type=int, help="X coordinate (for teleport)")
    parser.add_argument("--y", type=int, help="Y coordinate (for teleport)")
    parser.add_argument("--remove-items-json", type=str, help="JSON array of items to remove: [{itemId, count}]")
    parser.add_argument("--give-items-json", type=str, help="JSON array of items to give: [{itemId, count}]")
    parser.add_argument("--auto-save-interval", type=int, default=10, help="Auto-save interval in seconds for daemon mode (default: 10)")
    args = parser.parse_args()

    # Daemon mode - run persistent process
    if args.daemon:
        run_daemon(args.save_path, args.auto_save_interval)
        raise SystemExit(0)


    if args.give_item:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        if args.item_id is None:
            raise SystemExit("Missing --item-id")
        ok = give_item_to_blockhead(args.save_path, args.blockhead_id, args.item_id, args.count,
                                    player_uuid=args.player_uuid, damage=args.damage, color=args.color,
                                    basket_only=args.basket_only)
        print(json.dumps({"ok": bool(ok)}))
        raise SystemExit(0 if ok else 1)
    if args.take_item:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        if args.item_id is None:
            raise SystemExit("Missing --item-id")
        result = take_item_from_blockhead(args.save_path, args.blockhead_id, args.item_id, args.count, player_uuid=args.player_uuid)
        print(json.dumps(result))
        raise SystemExit(0 if result.get("success") else 1)
    if args.list_blockheads:
        if not args.player_uuid:
            raise SystemExit("Missing --player-uuid")
        ids = list_blockheads_for_player(args.save_path, args.player_uuid)
        print(json.dumps({"playerUuid": args.player_uuid, "blockheadIds": ids}))
        raise SystemExit(0)
    if args.list_blockheads_with_names:
        if not args.player_uuid:
            raise SystemExit("Missing --player-uuid")
        result = list_blockheads_with_names(args.save_path, args.player_uuid)
        print(json.dumps(result))
        raise SystemExit(0 if result.get("ok") else 1)
    if getattr(args, 'find_blockhead_owner', False):
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        gs = GameSave.load_lite(args.save_path)
        player_uuid = find_player_uuid_for_blockhead(gs, args.blockhead_id)
        if player_uuid:
            print(json.dumps({"blockheadId": args.blockhead_id, "playerUuid": player_uuid}))
            raise SystemExit(0)
        else:
            print(json.dumps({"blockheadId": args.blockhead_id, "playerUuid": None, "error": "Owner not found"}))
            raise SystemExit(1)
    if args.inventory_counts:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        counts = get_inventory_counts(args.save_path, args.blockhead_id)
        if counts is None:
            print(json.dumps({"error": "Blockhead not found", "blockheadId": args.blockhead_id}))
            raise SystemExit(1)
        print(json.dumps({"blockheadId": args.blockhead_id, "items": counts}))
        raise SystemExit(0)
    if args.player_inventory_counts:
        if not args.player_uuid:
            raise SystemExit("Missing --player-uuid")
        counts = get_all_blockhead_inventory_counts(args.save_path, args.player_uuid)
        print(json.dumps({"playerUuid": args.player_uuid, "items": counts}))
        raise SystemExit(0)
    if args.get_blockhead_position:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        if not args.player_uuid:
            raise SystemExit("Missing --player-uuid")
        result = get_blockhead_position(args.save_path, args.player_uuid, args.blockhead_id)
        print(json.dumps(result))
        raise SystemExit(0 if result.get("ok") else 1)
    if args.teleport_blockhead:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        if not args.player_uuid:
            raise SystemExit("Missing --player-uuid")
        if args.x is None or args.y is None:
            raise SystemExit("Missing --x or --y")
        result = teleport_blockhead_targeted(args.save_path, args.player_uuid, args.blockhead_id, args.x, args.y)
        result.pop("_bh_key", None)
        print(json.dumps(result))
        raise SystemExit(0 if result.get("ok") else 1)
    if args.apply_quest_items:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        if not args.player_uuid:
            raise SystemExit("Missing --player-uuid")
        try:
            remove_items = json.loads(args.remove_items_json or "[]")
            give_items = json.loads(args.give_items_json or "[]")
        except Exception:
            print(json.dumps({"success": False, "error": "Invalid --remove-items-json or --give-items-json"}))
            raise SystemExit(1)
        result = apply_quest_items_targeted(args.save_path, args.blockhead_id, remove_items, give_items, args.player_uuid)
        print(json.dumps(result))
        raise SystemExit(0 if result.get("success") else 1)
    main()
