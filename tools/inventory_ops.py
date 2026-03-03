"""Inventory query and manipulation operations (read-only + clear)."""

import os
from gameSave import GameSave
from item import Item
from item_utils import get_basket_slots, get_slot_item, get_item_name


def find_player_uuid_for_blockhead(gs, blockhead_uid):
    """Find the player UUID that owns a given blockhead id."""
    main_db = gs._data["world_db"][b"main"]
    suffix = f"_blockhead_{blockhead_uid}_inventory"
    for key in main_db.keys():
        try:
            key_str = key.decode('utf-8', errors='ignore')
        except Exception:
            continue
        if key_str.endswith(suffix):
            return key_str.split('_blockhead_')[0]
    return None


def list_blockheads_for_player(save_path, player_uuid, gs=None, lite=True):
    """Return blockhead ids for a player UUID.

    Note: Player UUIDs from game may have dashes (e.g., 7ab07653-e464-54c7-8377-c53ca69307b1)
    but DB keys use the format without dashes. We try both.

    Args:
        lite: If True and gs is None, use lite mode to save memory (skips blocks/dw).
    """
    gs = gs or (GameSave.load_lite(save_path) if lite else GameSave.load(save_path))
    main_db = gs._data["world_db"][b"main"]

    # Try both formats: with dashes and without dashes
    uuid_variants = [player_uuid, player_uuid.replace('-', '')]

    blockhead_ids = []
    for uuid_variant in uuid_variants:
        prefix = f"{uuid_variant}_blockhead_"
        for key in main_db.keys():
            try:
                key_str = key.decode('utf-8', errors='ignore')
            except Exception:
                continue
            if key_str.startswith(prefix) and key_str.endswith("_inventory"):
                try:
                    blockhead_id = int(key_str.split("_blockhead_")[1].replace("_inventory", ""))
                    blockhead_ids.append(blockhead_id)
                except Exception:
                    continue
        # If we found blockheads with this variant, no need to try others
        if blockhead_ids:
            break

    return sorted(set(blockhead_ids))


def inventory_has_space(gs, blockhead_uid, player_uuid_override=None, owner_index=None):
    """Return True if the blockhead has at least one empty inventory slot (including baskets)."""
    # Use provided UUID, then index, then slow scan as fallback
    player_uuid = player_uuid_override
    if not player_uuid and owner_index is not None and blockhead_uid in owner_index:
        player_uuid = owner_index[blockhead_uid]
    if not player_uuid:
        player_uuid = find_player_uuid_for_blockhead(gs, blockhead_uid)
    if not player_uuid:
        return False

    main_db = gs._data["world_db"][b"main"]
    inv_key = f"{player_uuid}_blockhead_{blockhead_uid}_inventory".encode('utf-8')
    if inv_key not in main_db:
        return False

    inv_wrapper = main_db[inv_key]
    inv_data = inv_wrapper._data[0]._data

    # Check main inventory slots first
    for slot_data in inv_data:
        if not isinstance(slot_data, list) or len(slot_data) == 0:
            return True

    # Check baskets for an empty slot
    for slot_data in inv_data:
        if not isinstance(slot_data, list) or len(slot_data) == 0:
            continue
        try:
            item_obj = Item(slot_data)
        except Exception:
            continue
        if item_obj.get_id() != 12:
            continue
        basket_storage = get_basket_slots(item_obj)
        if basket_storage is None:
            return True
        for basket_slot_idx in range(4):
            actual_storage_idx = 3 - basket_slot_idx
            slot = basket_storage[actual_storage_idx]
            if slot is None:
                return True
            if isinstance(slot, list) and len(slot) == 0:
                return True
            if isinstance(slot, Item) and slot.count == 0:
                return True
    return False


def get_inventory_counts(save_path, blockhead_uid, gs=None, lite=True, owner_index=None):
    """Get item counts for a blockhead's inventory (main slots + baskets).

    Returns a dict: { itemId: totalCount, ... }

    Args:
        lite: If True and gs is None, use lite mode to save memory.
        owner_index: Optional dict mapping blockhead_id -> player_uuid for O(1) lookup.
    """
    gs = gs or (GameSave.load_lite(save_path) if lite else GameSave.load(save_path))
    # Use index for fast lookup if available, fallback to slow scan
    if owner_index is not None and blockhead_uid in owner_index:
        player_uuid = owner_index[blockhead_uid]
    else:
        player_uuid = find_player_uuid_for_blockhead(gs, blockhead_uid)
    if not player_uuid:
        return None

    main_db = gs._data["world_db"][b"main"]
    inv_key = f"{player_uuid}_blockhead_{blockhead_uid}_inventory".encode('utf-8')

    if inv_key not in main_db:
        return None

    inv_wrapper = main_db[inv_key]
    inv_data = inv_wrapper._data[0]._data

    counts = {}  # itemId -> count

    for slot_data in inv_data:
        if not isinstance(slot_data, list) or len(slot_data) == 0:
            continue

        try:
            item_obj = Item(slot_data)
            item_id = item_obj.get_id()
            item_count = item_obj.get_count()

            # Check if this is a basket
            if item_id == 12:  # Basket
                # Count basket itself
                counts[12] = counts.get(12, 0) + 1

                basket_storage = get_basket_slots(item_obj)
                if basket_storage is None:
                    continue

                # Check each basket slot
                for basket_slot_idx in range(4):
                    actual_storage_idx = 3 - basket_slot_idx
                    slot_item = get_slot_item(basket_storage[actual_storage_idx])
                    if slot_item:
                        slot_item_id = slot_item.get_id()
                        counts[slot_item_id] = counts.get(slot_item_id, 0) + slot_item.count
            else:
                # Regular item
                counts[item_id] = counts.get(item_id, 0) + item_count

        except Exception:
            continue

    return counts


def get_all_blockhead_inventory_counts(save_path, player_uuid, gs=None, lite=True):
    """Get combined item counts for ALL blockheads of a player.

    Returns a dict: { itemId: totalCount, ... }

    Args:
        lite: If True and gs is None, use lite mode to save memory.
    """
    gs = gs or (GameSave.load_lite(save_path) if lite else GameSave.load(save_path))
    blockhead_ids = list_blockheads_for_player(save_path, player_uuid, gs)

    combined_counts = {}

    for blockhead_id in blockhead_ids:
        counts = get_inventory_counts(save_path, blockhead_id, gs)
        if counts:
            for item_id, count in counts.items():
                combined_counts[item_id] = combined_counts.get(item_id, 0) + count

    return combined_counts


def clear_inventory(gs, player_uuid, blockhead_uid, save=True, output_path=None):
    """Clear all items from a player's inventory."""
    main_db = gs._data["world_db"][b"main"]
    inv_key = f"{player_uuid}_blockhead_{blockhead_uid}_inventory".encode('utf-8')

    if inv_key not in main_db:
        print(f"Inventory not found")
        return False

    inv_wrapper = main_db[inv_key]
    inv_data = inv_wrapper._data[0]._data

    # Clear all 8 slots
    for slot_idx in range(len(inv_data)):
        inv_data[slot_idx] = []

    print(f"Cleared all items from blockhead {blockhead_uid}'s inventory")

    if save and output_path:
        gs.save(output_path)
        print("Changes saved")

    return True
