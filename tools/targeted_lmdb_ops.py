"""Targeted LMDB read/write operations (give, take, teleport, quest items).

These functions open LMDB directly for single-key atomic writes,
bypassing the GameSave cache for guaranteed fresh reads.
"""

import os
import lmdb
from item import Item
from lmdb_parser import parse_value
from item_utils import make_item, get_basket_slots, set_basket_slots, get_slot_item, get_item_name


def _find_inventory_key(txn, main_db, blockhead_uid):
    """Scan main_db key names for the inventory key matching blockhead_uid.
    Key-names-only scan -- no value parsing. Returns key bytes or None.
    """
    suffix = f"_blockhead_{blockhead_uid}_inventory".encode('utf-8')
    cursor = txn.cursor(main_db)
    try:
        if cursor.first():
            while True:
                key = cursor.key()
                if key.endswith(suffix):
                    return key
                if not cursor.next():
                    break
    finally:
        cursor.close()
    return None


def _sync_gs_inventory_key(gs, world_db_path, inv_key):
    """Re-read one inventory key from LMDB into gs._data to keep gs in sync
    after a targeted write. Prevents forceSave() from overwriting targeted writes.
    Single O(log n) key read -- negligible cost.
    """
    try:
        env = lmdb.open(world_db_path, readonly=True, max_dbs=10, map_size=6 * 1024 * 1024 * 1024)
        try:
            with env.begin() as txn:
                main_db = env.open_db(b'main', txn=txn, create=False)
                raw = txn.get(inv_key, db=main_db)
                if raw:
                    gs._data["world_db"][b"main"][inv_key] = parse_value(raw)
        finally:
            env.close()
    except Exception:
        pass  # Best-effort sync; targeted write already succeeded


def _resolve_inv_key(txn, main_db, blockhead_uid, player_uuid):
    """Resolve the LMDB inventory key for a blockhead. O(log n) if player_uuid given, else O(n) scan."""
    if player_uuid:
        inv_key = f"{player_uuid}_blockhead_{blockhead_uid}_inventory".encode('utf-8')
        if txn.get(inv_key, db=main_db):
            return inv_key
        return None
    return _find_inventory_key(txn, main_db, blockhead_uid)


def apply_quest_items_targeted(save_path, blockhead_uid, remove_items, give_items, player_uuid=None):
    """Take required items AND give reward items in a single LMDB write transaction.

    Reads fresh from disk (no stale gs). Atomically applies all changes.
    player_uuid enables O(log n) key lookup; omit for O(n) suffix scan.
    """
    world_db_path = os.path.join(save_path, "world_db")
    env = None
    try:
        env = lmdb.open(world_db_path, max_dbs=10, map_size=6 * 1024 * 1024 * 1024)
        with env.begin(write=True) as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)

            inv_key = _resolve_inv_key(txn, main_db, blockhead_uid, player_uuid)
            if not inv_key:
                return {"success": False, "error": "player_uuid_not_found"}

            raw = txn.get(inv_key, db=main_db)
            if not raw:
                return {"success": False, "error": "inventory_not_found"}

            inv_wrapper = parse_value(raw)
            inv_data = inv_wrapper._data[0]._data

            # --- Take phase ---
            for entry in remove_items:
                item_id = int(entry.get("itemId", 0))
                needed = int(entry.get("count", 0))
                if item_id <= 0 or needed <= 0:
                    continue
                total_taken = 0
                for slot_idx, slot_data in enumerate(inv_data):
                    if total_taken >= needed:
                        break
                    if not isinstance(slot_data, list) or len(slot_data) == 0:
                        continue
                    item_obj = Item(slot_data)
                    if item_obj.get_id() == 12:  # Basket
                        basket_storage = get_basket_slots(item_obj)
                        if basket_storage is None:
                            continue
                        basket_modified = False
                        for basket_slot_idx in range(4):
                            if total_taken >= needed:
                                break
                            actual_idx = 3 - basket_slot_idx
                            slot_item = get_slot_item(basket_storage[actual_idx])
                            if slot_item and slot_item.get_id() == item_id:
                                available = slot_item.count
                                to_take = min(available, needed - total_taken)
                                if to_take >= available:
                                    basket_storage[actual_idx] = []
                                else:
                                    basket_storage[actual_idx] = make_item(item_id, available - to_take).export()
                                basket_modified = True
                                total_taken += to_take
                        if basket_modified:
                            set_basket_slots(item_obj, basket_storage)
                            inv_data[slot_idx] = item_obj.export()
                    elif item_obj.get_id() == item_id:
                        available = item_obj.get_count()
                        to_take = min(available, needed - total_taken)
                        new_count = available - to_take
                        if new_count == 0:
                            inv_data[slot_idx] = []
                        else:
                            item_obj.set_count(new_count)
                            inv_data[slot_idx] = item_obj.export()
                        total_taken += to_take
                if total_taken < needed:
                    return {"success": False, "error": "insufficient_items",
                            "itemId": item_id, "taken": total_taken, "requested": needed}

            # --- Give phase ---
            result = _place_items_in_inventory(inv_data, give_items)
            if result is not None:
                return result

            txn.put(inv_key, inv_wrapper.export(), db=main_db)
            return {"success": True}
    except Exception as e:
        return {"success": False, "error": f"apply_quest_items_targeted error: {e}"}
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


def give_item_to_blockhead(save_path, blockhead_uid, item_id, count, player_uuid=None,
                           damage=None, color=None, level=None, basket_only=False):
    """Give an item to a blockhead by id. Fast path: targeted LMDB read/write.

    If player_uuid is provided, the inventory key is built directly (O(log n)).
    Otherwise a key-name suffix scan is used to find it (O(n), still fast).

    Optional damage/color/level: when any is set, always places in a fresh slot
    (no stacking onto existing items).
    basket_only: if True, skip main inventory slots and place only in a basket.
                 If no basket exists, one is created first.
    """
    try:
        count = int(count)
    except Exception:
        count = 1
    if count < 1:
        count = 1
    special = damage is not None or color is not None or level is not None

    world_db_path = os.path.join(save_path, "world_db")
    env = None
    try:
        env = lmdb.open(world_db_path, max_dbs=10, map_size=6 * 1024 * 1024 * 1024)
        with env.begin(write=True) as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)

            inv_key = _resolve_inv_key(txn, main_db, blockhead_uid, player_uuid)
            if not inv_key:
                print(f"Player UUID not found for blockhead {blockhead_uid}")
                return False

            raw = txn.get(inv_key, db=main_db)
            if not raw:
                print(f"Inventory not found for blockhead {blockhead_uid}")
                return False

            inv_wrapper = parse_value(raw)
            inv_data = inv_wrapper._data[0]._data

            # Try empty/matching slots in main inventory (skipped when basket_only=True)
            placed = False
            if not basket_only:
                for slot_idx, slot_data in enumerate(inv_data):
                    if not isinstance(slot_data, list) or len(slot_data) == 0:
                        inv_data[slot_idx] = make_item(item_id, count, damage, color, level).export()
                        placed = True
                        break
                    if not special and Item(slot_data).get_id() == item_id:
                        existing_count = Item(slot_data).get_count()
                        inv_data[slot_idx] = make_item(item_id, existing_count + count).export()
                        placed = True
                        break

            # Try baskets
            if not placed:
                placed = _place_in_basket(inv_data, item_id, count, damage, color, level)

            # basket_only: no basket found -- create one in an empty main slot, put item inside
            if not placed and basket_only:
                for slot_idx, slot_data in enumerate(inv_data):
                    if not isinstance(slot_data, list) or len(slot_data) == 0:
                        basket_obj = make_item(12, 1)  # item ID 12 = basket
                        new_item_bytes = make_item(item_id, count, damage, color, level).export()
                        basket_obj.items[0].init_extra({'s': [new_item_bytes, [], [], []]})
                        inv_data[slot_idx] = basket_obj.export()
                        placed = True
                        break

            if not placed:
                print(f"No inventory space for blockhead {blockhead_uid}")
                return False

            txn.put(inv_key, inv_wrapper.export(), db=main_db)
            return True
    except Exception as e:
        print(f"Error giving item to blockhead {blockhead_uid}: {e}")
        return False
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


def take_item_from_blockhead(save_path, blockhead_uid, item_id, count, player_uuid=None):
    """Take items from a blockhead by id. Returns JSON result. Fast path: targeted LMDB read/write.

    If player_uuid is provided, the inventory key is built directly (O(log n)).
    Otherwise a key-name suffix scan is used to find it (O(n), still fast).
    """
    try:
        count = int(count)
    except Exception:
        count = 1
    if count < 1:
        count = 1

    world_db_path = os.path.join(save_path, "world_db")
    env = None
    try:
        env = lmdb.open(world_db_path, max_dbs=10, map_size=6 * 1024 * 1024 * 1024)
        with env.begin(write=True) as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)

            inv_key = _resolve_inv_key(txn, main_db, blockhead_uid, player_uuid)
            if not inv_key:
                return {"success": False, "error": f"Player UUID not found for blockhead {blockhead_uid}"}

            raw = txn.get(inv_key, db=main_db)
            if not raw:
                return {"success": False, "error": "Inventory not found"}

            inv_wrapper = parse_value(raw)
            inv_data = inv_wrapper._data[0]._data
            total_taken = 0

            for slot_idx, slot_data in enumerate(inv_data):
                if total_taken >= count:
                    break
                if not isinstance(slot_data, list) or len(slot_data) == 0:
                    continue

                item_obj = Item(slot_data)

                if item_obj.get_id() == 12:  # Basket
                    basket_storage = get_basket_slots(item_obj)
                    if basket_storage is None:
                        continue
                    basket_modified = False
                    for basket_slot_idx in range(4):
                        if total_taken >= count:
                            break
                        actual_storage_idx = 3 - basket_slot_idx
                        slot_item = get_slot_item(basket_storage[actual_storage_idx])
                        if slot_item and slot_item.get_id() == item_id:
                            available = slot_item.count
                            to_take = min(available, count - total_taken)
                            if to_take > 0:
                                if to_take >= available:
                                    basket_storage[actual_storage_idx] = []
                                else:
                                    basket_storage[actual_storage_idx] = make_item(item_id, available - to_take).export()
                                basket_modified = True
                                total_taken += to_take
                    if basket_modified:
                        set_basket_slots(item_obj, basket_storage)
                        inv_data[slot_idx] = item_obj.export()

                elif item_obj.get_id() == item_id:
                    available = item_obj.get_count()
                    to_take = min(available, count - total_taken)
                    if to_take > 0:
                        new_count = available - to_take
                        if new_count == 0:
                            inv_data[slot_idx] = []
                        else:
                            item_obj.set_count(new_count)
                            inv_data[slot_idx] = item_obj.export()
                        total_taken += to_take

            if total_taken > 0:
                txn.put(inv_key, inv_wrapper.export(), db=main_db)
                return {
                    "success": True,
                    "taken": total_taken,
                    "requested": count,
                    "itemId": item_id,
                    "itemName": get_item_name(item_id),
                    "blockheadId": blockhead_uid
                }
            else:
                return {
                    "success": False,
                    "error": f"No {get_item_name(item_id)} found in inventory",
                    "taken": 0,
                    "requested": count,
                    "itemId": item_id,
                    "blockheadId": blockhead_uid
                }
    except Exception as e:
        return {"success": False, "error": f"Error taking item from blockhead {blockhead_uid}: {e}"}
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


def teleport_blockhead_targeted(save_path, player_uuid, blockhead_uid, x, y):
    """Teleport a blockhead to (x, y) with a single targeted LMDB write transaction.

    Reads fresh from disk (no stale gs). No forceSave needed -- write is immediate.
    player_uuid is required (no suffix scan; bh_key is derived from UUID directly).
    """
    bh_key = f"{player_uuid.replace('-', '')}_blockheads".encode('utf-8')
    world_db_path = os.path.join(save_path, "world_db")
    env = None
    try:
        env = lmdb.open(world_db_path, max_dbs=10, map_size=6 * 1024 * 1024 * 1024)
        with env.begin(write=True) as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)
            raw = txn.get(bh_key, db=main_db)
            if not raw:
                return {"ok": False, "error": "blockheads_key_not_found"}

            bh_wrapper = parse_value(raw)
            bh_data = bh_wrapper._data[0]._data
            if not isinstance(bh_data, dict):
                return {"ok": False, "error": "invalid_blockheads_data"}

            dynamic_objects = bh_data.get('dynamicObjects', [])
            found = False
            for obj in dynamic_objects:
                obj_data = obj
                if hasattr(obj_data, '_data'):
                    obj_data = obj_data._data
                if isinstance(obj_data, list) and len(obj_data) == 1:
                    obj_data = obj_data[0]
                    if hasattr(obj_data, '_data'):
                        obj_data = obj_data._data
                if not isinstance(obj_data, dict):
                    continue
                if obj_data.get('uniqueID') == blockhead_uid:
                    obj_data['pos_x'] = int(x)
                    obj_data['pos_y'] = int(y)
                    if 'floatPos' in obj_data:
                        obj_data['floatPos'] = [float(x), float(y)]
                    found = True
                    break

            if not found:
                return {"ok": False, "error": "blockhead_not_found_in_dynamicObjects"}

            txn.put(bh_key, bh_wrapper.export(), db=main_db)
            return {"ok": True, "_bh_key": bh_key}  # _bh_key internal only, stripped before JSON
    except Exception as e:
        return {"ok": False, "error": f"teleport_blockhead_targeted error: {e}"}
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Targeted read operations (no write, no GameSave)
# ---------------------------------------------------------------------------

def get_blockhead_position(save_path, player_uuid, blockhead_uid):
    """Get a blockhead's position from LMDB. Returns {"ok": True, "x": N, "y": N} or error."""
    uuid_nodash = player_uuid.replace('-', '')
    bh_key = f"{uuid_nodash}_blockheads".encode('utf-8')
    world_db_path = os.path.join(save_path, "world_db")
    env = None
    try:
        env = lmdb.open(world_db_path, readonly=True, max_dbs=10, map_size=6 * 1024 * 1024 * 1024, lock=False)
        with env.begin() as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)
            raw = txn.get(bh_key, db=main_db)
            if not raw:
                return {"ok": False, "error": "blockheads_key_not_found"}
            bh_wrapper = parse_value(raw)
            bh_data = bh_wrapper._data[0]._data
            if not isinstance(bh_data, dict):
                return {"ok": False, "error": "invalid_blockheads_data"}
            for obj in bh_data.get('dynamicObjects', []):
                obj_data = obj
                if hasattr(obj_data, '_data'):
                    obj_data = obj_data._data
                if isinstance(obj_data, list) and len(obj_data) == 1:
                    obj_data = obj_data[0]
                    if hasattr(obj_data, '_data'):
                        obj_data = obj_data._data
                if not isinstance(obj_data, dict):
                    continue
                if obj_data.get('uniqueID') == blockhead_uid:
                    return {"ok": True, "x": obj_data.get('pos_x', 0), "y": obj_data.get('pos_y', 0)}
            return {"ok": False, "error": "blockhead_not_found"}
    except Exception as e:
        return {"ok": False, "error": str(e)}
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


def list_blockheads_with_names(save_path, player_uuid):
    """List blockheads with their in-game names from the _blockheads LMDB key."""
    uuid_nodash = player_uuid.replace('-', '')
    bh_key = f"{uuid_nodash}_blockheads".encode('utf-8')
    world_db_path = os.path.join(save_path, "world_db")
    env = None
    try:
        env = lmdb.open(world_db_path, readonly=True, max_dbs=10, map_size=6 * 1024 * 1024 * 1024, lock=False)
        with env.begin() as txn:
            main_db = env.open_db(b'main', txn=txn, create=False)
            raw = txn.get(bh_key, db=main_db)
            if not raw:
                return {"ok": True, "blockheads": []}
            bh_wrapper = parse_value(raw)
            bh_data = bh_wrapper._data[0]._data
            if not isinstance(bh_data, dict):
                return {"ok": True, "blockheads": []}
            result = []
            for obj in bh_data.get('dynamicObjects', []):
                obj_data = obj
                if hasattr(obj_data, '_data'):
                    obj_data = obj_data._data
                if isinstance(obj_data, list) and len(obj_data) == 1:
                    obj_data = obj_data[0]
                    if hasattr(obj_data, '_data'):
                        obj_data = obj_data._data
                if isinstance(obj_data, dict):
                    result.append({
                        "blockheadId": obj_data.get('uniqueID'),
                        "name": obj_data.get('name', 'Unknown'),
                    })
            return {"ok": True, "blockheads": result}
    except Exception as e:
        return {"ok": False, "error": str(e), "blockheads": []}
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Shared helpers for placing items in inventory slots
# ---------------------------------------------------------------------------

def _place_items_in_inventory(inv_data, give_items):
    """Place multiple items into inventory. Returns error dict if no space, else None on success."""
    for entry in give_items:
        item_id = int(entry.get("itemId", 0))
        count = int(entry.get("count", 0))
        if item_id <= 0 or count <= 0:
            continue
        g_damage = entry.get("damage")
        g_color = entry.get("color")
        g_level = entry.get("level")
        g_special = g_damage is not None or g_color is not None or g_level is not None
        placed = False
        for slot_idx, slot_data in enumerate(inv_data):
            if not isinstance(slot_data, list) or len(slot_data) == 0:
                inv_data[slot_idx] = make_item(item_id, count, g_damage, g_color, g_level).export()
                placed = True
                break
            if not g_special and Item(slot_data).get_id() == item_id:
                existing_count = Item(slot_data).get_count()
                inv_data[slot_idx] = make_item(item_id, existing_count + count).export()
                placed = True
                break
        if not placed:
            placed = _place_in_basket(inv_data, item_id, count, g_damage, g_color, g_level)
        if not placed:
            return {"success": False, "error": "no_space", "itemId": item_id}
    return None


def _place_in_basket(inv_data, item_id, count, damage=None, color=None, level=None):
    """Try to place an item in the first available basket slot. Returns True if placed."""
    for slot_idx, slot_data in enumerate(inv_data):
        if not isinstance(slot_data, list) or len(slot_data) == 0:
            continue
        item_obj = Item(slot_data)
        if item_obj.get_id() != 12:
            continue
        basket_storage = get_basket_slots(item_obj)
        if basket_storage is None:
            new_item_bytes = make_item(item_id, count, damage, color, level).export()
            item_obj.items[0].init_extra({'s': [new_item_bytes, [], [], []]})
            inv_data[slot_idx] = item_obj.export()
            return True
        for basket_slot_idx in range(4):
            actual_idx = 3 - basket_slot_idx
            slot = basket_storage[actual_idx]
            is_empty = (slot is None or
                        (isinstance(slot, list) and len(slot) == 0) or
                        (isinstance(slot, Item) and slot.count == 0))
            if is_empty:
                basket_storage[actual_idx] = make_item(item_id, count, damage, color, level).export()
                set_basket_slots(item_obj, basket_storage)
                inv_data[slot_idx] = item_obj.export()
                return True
    return False
