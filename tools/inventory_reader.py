#!/usr/bin/env python3
"""
Lightweight inventory reader - reads ONLY inventory data from LMDB.
Does NOT load the entire 91MB+ world database into memory.

This is ~100x faster than using GameSave.load() for inventory checks.
"""

import plistlib
import gzip
import sys
import struct
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

