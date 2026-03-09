#!/usr/bin/env python3
"""
Lightweight inventory reader - reads ONLY inventory data from LMDB.
Does NOT load the entire 91MB+ world database into memory.

This is ~100x faster than using GameSave.load() for inventory checks.
"""

import lmdb
import plistlib
import gzip
import json
import sys
import struct
from pathlib import Path
from item import Item


def decode_item_id_and_count(data: bytes) -> tuple[int, int]:
    """Decode item ID and count from raw item bytes."""
    if len(data) < 4:
        return (0, 0)
    item_id = struct.unpack('<H', data[0:2])[0]
    count = struct.unpack('<H', data[2:4])[0]
    # Handle stacked items vs single items with metadata
    if len(data) > 8 and count > 99:
        count = 1  # Likely durability/metadata, not count
    return (item_id, max(1, count) if item_id != 0 else 0)


def parse_inventory_plist(data: bytes) -> dict[int, int]:
    """Parse inventory plist data and return item counts.

    Inventory structure (from item.py/inventory.py):
    - Inventory is a list of 8 slots
    - Each slot is a list of bytes entries (stacked items = multiple entries)
    - Each bytes entry is 8+ bytes, with item ID in first 2 bytes (little-endian)
    - The count for a slot is len(slot_list) - each entry represents 1 item
    """
    counts = {}

    try:
        # Handle gzip compression
        if data.startswith(b'\x1f\x8b'):
            data = gzip.decompress(data)

        # Handle plist formats
        if data.startswith(b'bplist00') or data.startswith(b'<?xml'):
            plist = plistlib.loads(data)
        else:
            return counts

        # Inventory is a list of slots
        if not isinstance(plist, list):
            return counts

        for slot in plist:
            # Empty slot - can be empty list [], integer 0, or None
            if not slot:
                continue
            if isinstance(slot, int) and slot == 0:
                continue

            # Slot is a list of bytes - parse with Item to handle baskets/extra data
            if isinstance(slot, list):
                try:
                    item_obj = Item(slot)
                    item_id = item_obj.get_id()
                    item_count = item_obj.get_count()

                    # Basket (container) - count items inside
                    if item_id == 12:
                        counts[item_id] = counts.get(item_id, 0) + max(1, item_count)

                        if item_obj.items and item_obj.items[0].has_extra:
                            basket_extra = item_obj.items[0]._zip._data[0]
                            if hasattr(basket_extra, '_data'):
                                basket_extra = basket_extra._data

                            if isinstance(basket_extra, dict) and 's' in basket_extra:
                                basket_storage = basket_extra['s']
                                for basket_slot_idx in range(4):
                                    actual_storage_idx = 3 - basket_slot_idx
                                    slot_item = basket_storage[actual_storage_idx]
                                    # Normalize: list -> Item
                                    if isinstance(slot_item, list) and len(slot_item) > 0:
                                        try:
                                            slot_item = Item(slot_item)
                                        except Exception:
                                            continue
                                    if isinstance(slot_item, Item) and slot_item.count > 0:
                                        slot_item_id = slot_item.get_id()
                                        counts[slot_item_id] = counts.get(slot_item_id, 0) + slot_item.count
                    else:
                        if item_id > 0:
                            counts[item_id] = counts.get(item_id, 0) + max(1, item_count)
                except Exception:
                    # Fallback: count by raw bytes if parsing fails
                    for item_data in slot:
                        if isinstance(item_data, bytes) and len(item_data) >= 2:
                            item_id = struct.unpack('<H', item_data[0:2])[0]
                            if item_id > 0:
                                counts[item_id] = counts.get(item_id, 0) + 1

            # Single bytes entry (rare, but handle it)
            elif isinstance(slot, bytes) and len(slot) >= 2:
                item_id = struct.unpack('<H', slot[0:2])[0]
                if item_id > 0:
                    counts[item_id] = counts.get(item_id, 0) + 1

    except Exception as e:
        sys.stderr.write(f"Parse error: {e}\n")

    return counts


def get_inventory_counts_fast(save_path: str, player_uuid: str) -> dict[int, int]:
    """
    Get inventory item counts for a player WITHOUT loading the entire database.

    This opens LMDB in read-only mode and only reads the specific inventory keys.
    Memory usage: ~1-2MB vs ~100MB+ for full GameSave.load()

    Note: Player UUIDs from game may have dashes (e.g., 7ab07653-e464-54c7-8377-c53ca69307b1)
    but DB keys use the format without dashes. We try both.
    """
    world_db_path = Path(save_path) / "world_db"

    if not world_db_path.exists():
        return {}

    combined_counts = {}

    # Try both formats: with dashes and without dashes
    uuid_variants = [player_uuid, player_uuid.replace('-', '')]

    try:
        # Open LMDB in read-only mode with minimal memory mapping
        env = lmdb.open(
            str(world_db_path),
            readonly=True,
            max_dbs=10,
            map_size=6 * 1024 * 1024 * 1024,  # 6GB max
            readahead=False,  # Don't prefetch - we only need specific keys
            lock=False  # Read-only, no need for locks
        )

        with env.begin() as txn:
            # Open the 'main' sub-database
            main_db = env.open_db(b'main', txn=txn, create=False)

            suffix = b"_inventory"

            # Try each UUID variant (with dashes and without)
            for uuid_variant in uuid_variants:
                prefix = f"{uuid_variant}_blockhead_".encode('utf-8')
                cursor = txn.cursor(main_db)

                # Position cursor at or after the prefix
                if cursor.set_range(prefix):
                    while True:
                        key = cursor.key()

                        # Check if we've gone past all keys for this player
                        if not key.startswith(prefix):
                            break

                        # Check if this is an inventory key
                        if key.endswith(suffix):
                            value = cursor.value()
                            if value:
                                inv_counts = parse_inventory_plist(value)
                                for item_id, count in inv_counts.items():
                                    combined_counts[item_id] = combined_counts.get(item_id, 0) + count

                        if not cursor.next():
                            break

                cursor.close()

                # If we found items with this variant, no need to try others
                if combined_counts:
                    break

        env.close()

    except Exception as e:
        sys.stderr.write(f"Error reading inventory: {e}\n")

    return combined_counts


def get_blockhead_inventory_counts_fast(save_path: str, player_uuid: str, blockhead_id: int) -> dict[int, int]:
    """Get inventory item counts for a specific blockhead of a player."""
    world_db_path = Path(save_path) / "world_db"

    if not world_db_path.exists():
        return {}

    uuid_variants = [player_uuid, player_uuid.replace('-', '')]
    suffix = f"_blockhead_{blockhead_id}_inventory".encode('utf-8')

    env = None
    try:
        env = lmdb.open(
            str(world_db_path),
            readonly=True,
            max_dbs=10,
            map_size=6 * 1024 * 1024 * 1024,  # 6GB max
            readahead=False,
            lock=False
        )

        with env.begin() as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)

            for uuid_variant in uuid_variants:
                key = f"{uuid_variant}".encode('utf-8') + suffix
                value = txn.get(key, db=main_db)
                if value:
                    return parse_inventory_plist(value)

    except Exception as e:
        sys.stderr.write(f"Error reading inventory: {e}\n")
    finally:
        if env is not None:
            env.close()

    return {}


def list_blockheads_fast(save_path: str, player_uuid: str) -> list[int]:
    """Get blockhead IDs for a player without loading full database.

    Note: Player UUIDs from game may have dashes but DB keys don't. We try both.
    """
    world_db_path = Path(save_path) / "world_db"

    if not world_db_path.exists():
        return []

    blockhead_ids = []

    # Try both formats: with dashes and without dashes
    uuid_variants = [player_uuid, player_uuid.replace('-', '')]

    try:
        env = lmdb.open(
            str(world_db_path),
            readonly=True,
            max_dbs=10,
            readahead=False,
            lock=False
        )

        with env.begin() as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)
            suffix = b"_inventory"

            for uuid_variant in uuid_variants:
                prefix = f"{uuid_variant}_blockhead_".encode('utf-8')
                cursor = txn.cursor(main_db)

                if cursor.set_range(prefix):
                    while True:
                        key = cursor.key()
                        if not key.startswith(prefix):
                            break
                        if key.endswith(suffix):
                            # Extract blockhead ID from key
                            try:
                                key_str = key.decode('utf-8')
                                parts = key_str.split('_blockhead_')
                                if len(parts) == 2:
                                    bid = int(parts[1].replace('_inventory', ''))
                                    blockhead_ids.append(bid)
                            except:
                                pass
                        if not cursor.next():
                            break

                cursor.close()

                # If we found blockheads with this variant, no need to try others
                if blockhead_ids:
                    break

        env.close()

    except Exception as e:
        sys.stderr.write(f"Error listing blockheads: {e}\n")

    return sorted(set(blockhead_ids))


def get_batch_inventory_counts_fast(save_path: str, player_uuids: list[str]) -> dict:
    """
    Get inventory counts for specific players' blockheads in one run.

    Returns:
    {
      "players": [
        {
          "playerUuid": "...",
          "blockheads": [
            { "blockheadId": 123, "items": { "1048": 10, ... } },
            ...
          ]
        },
        ...
      ]
    }
    """
    results = []
    for player_uuid in player_uuids:
        blockheads = []
        ids = list_blockheads_fast(save_path, player_uuid)
        for bid in ids:
            counts = get_blockhead_inventory_counts_fast(save_path, player_uuid, bid)
            blockheads.append({
                "blockheadId": bid,
                "items": counts
            })
        results.append({
            "playerUuid": player_uuid,
            "blockheads": blockheads
        })
    return {"players": results}


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Fast inventory reader")
    parser.add_argument("--inventory-counts", action="store_true", help="Get item counts for player")
    parser.add_argument("--blockhead-inventory-counts", action="store_true", help="Get item counts for a specific blockhead")
    parser.add_argument("--list-blockheads", action="store_true", help="List blockhead IDs")
    parser.add_argument("--inventory-counts-batch", action="store_true", help="Get item counts for multiple players' blockheads")
    parser.add_argument("--save-path", required=True, help="Path to world save")
    parser.add_argument("--player-uuid", help="Player UUID")
    parser.add_argument("--player-uuids-json", help="JSON array of player UUIDs (for batch)")
    parser.add_argument("--blockhead-id", type=int, help="Blockhead id")

    args = parser.parse_args()

    if args.inventory_counts:
        counts = get_inventory_counts_fast(args.save_path, args.player_uuid)
        print(json.dumps({"playerUuid": args.player_uuid, "items": counts}))

    elif args.blockhead_inventory_counts:
        if args.blockhead_id is None:
            raise SystemExit("Missing --blockhead-id")
        counts = get_blockhead_inventory_counts_fast(args.save_path, args.player_uuid, args.blockhead_id)
        print(json.dumps({"playerUuid": args.player_uuid, "blockheadId": args.blockhead_id, "items": counts}))

    elif args.list_blockheads:
        ids = list_blockheads_fast(args.save_path, args.player_uuid)
        print(json.dumps({"playerUuid": args.player_uuid, "blockheadIds": ids}))

    elif args.inventory_counts_batch:
        if args.player_uuids_json:
            try:
                uuids = json.loads(args.player_uuids_json)
            except Exception:
                raise SystemExit("Invalid --player-uuids-json")
        else:
            raise SystemExit("Missing --player-uuids-json")
        if not isinstance(uuids, list):
            raise SystemExit("Invalid --player-uuids-json")
        uuids = [u for u in uuids if isinstance(u, str) and u]
        result = get_batch_inventory_counts_fast(args.save_path, uuids)
        print(json.dumps(result))

    else:
        parser.print_help()
