"""WorldManager — OOP wrapper for targeted LMDB operations.

Persistent LMDB env (opened once), fresh transaction per command.
Each txn.begin() creates a new MVCC snapshot — no stale data risk.

Handles MDB_MAP_RESIZED transparently by reopening the env.

Usage:
    wm = WorldManager('/path/to/world/save')
    result = wm.give_item(blockhead_uid=123, item_id=1048, count=10, player_uuid='abc')
    wm.close()

Or as context manager:
    with WorldManager('/path/to/world/save') as wm:
        wm.teleport_blockhead('uuid', 123, 500, 200)
"""

import os
import lmdb
from contextlib import contextmanager
from item import Item
from lmdb_parser import parse_value
from item_utils import make_item, get_basket_slots, set_basket_slots, get_slot_item, get_item_name
from inventory_reader import parse_inventory_plist


class WorldManager:
    MAP_SIZE = 6 * 1024 * 1024 * 1024  # 6 GB virtual address space (not allocation)
    MAX_DBS = 10

    def __init__(self, save_path):
        self._save_path = save_path
        self._db_path = os.path.join(save_path, 'world_db')
        self._env = None
        self._open_env()

    def _open_env(self):
        """Open or reopen the LMDB environment."""
        if self._env is not None:
            try:
                self._env.close()
            except Exception:
                pass
        self._env = lmdb.open(self._db_path, max_dbs=self.MAX_DBS, map_size=self.MAP_SIZE)

    @contextmanager
    def _read_txn(self):
        """Fresh read-only transaction — always sees latest committed data."""
        try:
            txn = self._env.begin()
        except lmdb.MapResizedError:
            self._open_env()
            txn = self._env.begin()
        try:
            main_db = self._env.open_db(b'main', txn=txn, create=False)
            yield txn, main_db
        finally:
            txn.abort()

    @contextmanager
    def _write_txn(self):
        """Fresh write transaction — commits on clean exit, aborts on exception."""
        try:
            txn = self._env.begin(write=True)
        except lmdb.MapResizedError:
            self._open_env()
            txn = self._env.begin(write=True)
        committed = False
        try:
            main_db = self._env.open_db(b'main', txn=txn, create=False)
            yield txn, main_db
            txn.commit()
            committed = True
        except Exception:
            if not committed:
                txn.abort()
            raise

    def close(self):
        """Close the LMDB environment."""
        if self._env is not None:
            try:
                self._env.close()
            except Exception:
                pass
            self._env = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()

    def __del__(self):
        self.close()

    # -----------------------------------------------------------------------
    # Shared helpers
    # -----------------------------------------------------------------------

    @staticmethod
    def _unwrap_object(obj):
        """Unwrap a parsed LMDB dynamic object to a plain dict.

        Returns the inner dict (by reference — mutations propagate to the
        original tree), or None if the structure doesn't match.
        """
        obj_data = obj
        if hasattr(obj_data, '_data'):
            obj_data = obj_data._data
        if isinstance(obj_data, list) and len(obj_data) == 1:
            obj_data = obj_data[0]
            if hasattr(obj_data, '_data'):
                obj_data = obj_data._data
        return obj_data if isinstance(obj_data, dict) else None

    def _find_blockhead(self, bh_data, blockhead_uid):
        """Find a blockhead dict by uniqueID in dynamicObjects.

        Returns a reference to the dict inside the parsed tree (mutations propagate).
        """
        for obj in bh_data.get('dynamicObjects', []):
            obj_data = self._unwrap_object(obj)
            if obj_data and obj_data.get('uniqueID') == blockhead_uid:
                return obj_data
        return None

    @staticmethod
    def _find_inventory_key(txn, main_db, blockhead_uid):
        """O(n) key-name suffix scan for the inventory key."""
        suffix = f"_blockhead_{blockhead_uid}_inventory".encode('utf-8')
        cursor = txn.cursor(main_db)
        try:
            if cursor.first():
                while True:
                    if cursor.key().endswith(suffix):
                        return cursor.key()
                    if not cursor.next():
                        break
        finally:
            cursor.close()
        return None

    @staticmethod
    def _resolve_inv_key(txn, main_db, blockhead_uid, player_uuid):
        """Resolve inventory key. O(log n) with player_uuid, O(n) without."""
        if player_uuid:
            key = f"{player_uuid}_blockhead_{blockhead_uid}_inventory".encode('utf-8')
            if txn.get(key, db=main_db):
                return key
            return None
        return WorldManager._find_inventory_key(txn, main_db, blockhead_uid)

    @staticmethod
    def _take_items(inv_data, item_id, count):
        """Remove up to `count` of `item_id` from inventory slots (including baskets).

        Mutates inv_data in place. Returns number actually taken.
        """
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
                    actual_idx = 3 - basket_slot_idx
                    slot_item = get_slot_item(basket_storage[actual_idx])
                    if slot_item and slot_item.get_id() == item_id:
                        available = slot_item.count
                        to_take = min(available, count - total_taken)
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
                to_take = min(available, count - total_taken)
                new_count = available - to_take
                if new_count == 0:
                    inv_data[slot_idx] = []
                else:
                    item_obj.set_count(new_count)
                    inv_data[slot_idx] = item_obj.export()
                total_taken += to_take

        return total_taken

    @staticmethod
    def _place_in_basket(inv_data, item_id, count, damage=None, color=None, level=None):
        """Try to place item in first available basket slot. Returns True if placed."""
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

    @staticmethod
    def _place_items(inv_data, give_items):
        """Place multiple items into inventory. Returns error dict on failure, None on success."""
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
                placed = WorldManager._place_in_basket(inv_data, item_id, count, g_damage, g_color, g_level)
            if not placed:
                return {"success": False, "error": "no_space", "itemId": item_id}
        return None

    # -----------------------------------------------------------------------
    # Public API — inventory operations
    # -----------------------------------------------------------------------

    def give_item(self, blockhead_uid, item_id, count, player_uuid=None,
                  damage=None, color=None, level=None, basket_only=False):
        """Give item to blockhead. Returns True on success, False on failure."""
        try:
            count = int(count)
        except Exception:
            count = 1
        if count < 1:
            count = 1
        special = damage is not None or color is not None or level is not None

        try:
            with self._write_txn() as (txn, main_db):
                inv_key = self._resolve_inv_key(txn, main_db, blockhead_uid, player_uuid)
                if not inv_key:
                    return False

                raw = txn.get(inv_key, db=main_db)
                if not raw:
                    return False

                inv_wrapper = parse_value(raw)
                inv_data = inv_wrapper._data[0]._data

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

                if not placed:
                    placed = self._place_in_basket(inv_data, item_id, count, damage, color, level)

                if not placed and basket_only:
                    for slot_idx, slot_data in enumerate(inv_data):
                        if not isinstance(slot_data, list) or len(slot_data) == 0:
                            basket_obj = make_item(12, 1)
                            new_item_bytes = make_item(item_id, count, damage, color, level).export()
                            basket_obj.items[0].init_extra({'s': [new_item_bytes, [], [], []]})
                            inv_data[slot_idx] = basket_obj.export()
                            placed = True
                            break

                if not placed:
                    return False

                txn.put(inv_key, inv_wrapper.export(), db=main_db)
                return True
        except Exception as e:
            print(f"Error giving item to blockhead {blockhead_uid}: {e}")
            return False

    def take_item(self, blockhead_uid, item_id, count, player_uuid=None):
        """Take items from blockhead. Returns result dict with taken/requested counts."""
        try:
            count = int(count)
        except Exception:
            count = 1
        if count < 1:
            count = 1

        try:
            with self._write_txn() as (txn, main_db):
                inv_key = self._resolve_inv_key(txn, main_db, blockhead_uid, player_uuid)
                if not inv_key:
                    return {"success": False, "error": f"Player UUID not found for blockhead {blockhead_uid}"}

                raw = txn.get(inv_key, db=main_db)
                if not raw:
                    return {"success": False, "error": "Inventory not found"}

                inv_wrapper = parse_value(raw)
                inv_data = inv_wrapper._data[0]._data

                total_taken = self._take_items(inv_data, item_id, count)

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

    def apply_quest_items(self, blockhead_uid, remove_items, give_items, player_uuid=None):
        """Atomic take + give in one write transaction. All-or-nothing."""
        try:
            with self._write_txn() as (txn, main_db):
                inv_key = self._resolve_inv_key(txn, main_db, blockhead_uid, player_uuid)
                if not inv_key:
                    return {"success": False, "error": "player_uuid_not_found"}

                raw = txn.get(inv_key, db=main_db)
                if not raw:
                    return {"success": False, "error": "inventory_not_found"}

                inv_wrapper = parse_value(raw)
                inv_data = inv_wrapper._data[0]._data

                # Take phase — strict: must get exact count for each item
                for entry in remove_items:
                    item_id = int(entry.get("itemId", 0))
                    needed = int(entry.get("count", 0))
                    if item_id <= 0 or needed <= 0:
                        continue
                    taken = self._take_items(inv_data, item_id, needed)
                    if taken < needed:
                        return {"success": False, "error": "insufficient_items",
                                "itemId": item_id, "taken": taken, "requested": needed}

                # Give phase
                error = self._place_items(inv_data, give_items)
                if error is not None:
                    return error

                txn.put(inv_key, inv_wrapper.export(), db=main_db)
                return {"success": True}
        except Exception as e:
            return {"success": False, "error": f"apply_quest_items error: {e}"}

    # -----------------------------------------------------------------------
    # Public API — blockhead data operations
    # -----------------------------------------------------------------------

    def teleport_blockhead(self, player_uuid, blockhead_uid, x, y):
        """Teleport blockhead to (x, y). Single targeted LMDB write."""
        bh_key = f"{player_uuid.replace('-', '')}_blockheads".encode('utf-8')
        try:
            with self._write_txn() as (txn, main_db):
                raw = txn.get(bh_key, db=main_db)
                if not raw:
                    return {"ok": False, "error": "blockheads_key_not_found"}

                bh_wrapper = parse_value(raw)
                bh_data = bh_wrapper._data[0]._data
                if not isinstance(bh_data, dict):
                    return {"ok": False, "error": "invalid_blockheads_data"}

                obj_data = self._find_blockhead(bh_data, blockhead_uid)
                if not obj_data:
                    return {"ok": False, "error": "blockhead_not_found_in_dynamicObjects"}

                obj_data['pos_x'] = int(x)
                obj_data['pos_y'] = int(y)
                if 'floatPos' in obj_data:
                    obj_data['floatPos'] = [float(x), float(y)]

                txn.put(bh_key, bh_wrapper.export(), db=main_db)
                return {"ok": True}
        except Exception as e:
            return {"ok": False, "error": f"teleport_blockhead error: {e}"}

    def get_blockhead_position(self, player_uuid, blockhead_uid):
        """Get blockhead position from LMDB."""
        bh_key = f"{player_uuid.replace('-', '')}_blockheads".encode('utf-8')
        try:
            with self._read_txn() as (txn, main_db):
                raw = txn.get(bh_key, db=main_db)
                if not raw:
                    return {"ok": False, "error": "blockheads_key_not_found"}

                bh_wrapper = parse_value(raw)
                bh_data = bh_wrapper._data[0]._data
                if not isinstance(bh_data, dict):
                    return {"ok": False, "error": "invalid_blockheads_data"}

                obj_data = self._find_blockhead(bh_data, blockhead_uid)
                if not obj_data:
                    return {"ok": False, "error": "blockhead_not_found"}

                return {"ok": True, "x": obj_data.get('pos_x', 0), "y": obj_data.get('pos_y', 0)}
        except Exception as e:
            return {"ok": False, "error": str(e)}

    def list_blockheads_with_names(self, player_uuid):
        """List blockheads with their in-game names."""
        bh_key = f"{player_uuid.replace('-', '')}_blockheads".encode('utf-8')
        try:
            with self._read_txn() as (txn, main_db):
                raw = txn.get(bh_key, db=main_db)
                if not raw:
                    return {"ok": True, "blockheads": []}

                bh_wrapper = parse_value(raw)
                bh_data = bh_wrapper._data[0]._data
                if not isinstance(bh_data, dict):
                    return {"ok": True, "blockheads": []}

                result = []
                for obj in bh_data.get('dynamicObjects', []):
                    obj_data = self._unwrap_object(obj)
                    if obj_data:
                        result.append({
                            "blockheadId": obj_data.get('uniqueID'),
                            "name": obj_data.get('name', 'Unknown'),
                        })
                return {"ok": True, "blockheads": result}
        except Exception as e:
            return {"ok": False, "error": str(e), "blockheads": []}

    # -----------------------------------------------------------------------
    # Public API — inventory reads (uses persistent env via _read_txn)
    # -----------------------------------------------------------------------

    def list_blockheads(self, player_uuid: str) -> list:
        """List all blockhead IDs for a player by scanning inventory keys."""
        uuid_variants = [player_uuid, player_uuid.replace('-', '')]
        suffix = b'_inventory'
        try:
            with self._read_txn() as (txn, main_db):
                for uuid_variant in uuid_variants:
                    prefix = f'{uuid_variant}_blockhead_'.encode('utf-8')
                    cursor = txn.cursor(main_db)
                    ids = []
                    if cursor.set_range(prefix):
                        while True:
                            key = cursor.key()
                            if not key.startswith(prefix):
                                break
                            if key.endswith(suffix):
                                try:
                                    key_str = key.decode('utf-8')
                                    parts = key_str.split('_blockhead_')
                                    if len(parts) == 2:
                                        ids.append(int(parts[1].replace('_inventory', '')))
                                except Exception:
                                    pass
                            if not cursor.next():
                                break
                    cursor.close()
                    if ids:
                        return sorted(set(ids))
        except Exception as e:
            print(f'[WorldManager] list_blockheads error for {player_uuid}: {e}')
        return []

    def get_inventory_counts(self, player_uuid: str) -> dict:
        """Get combined inventory item counts across all blockheads of a player."""
        uuid_variants = [player_uuid, player_uuid.replace('-', '')]
        suffix = b'_inventory'
        combined = {}
        try:
            with self._read_txn() as (txn, main_db):
                for uuid_variant in uuid_variants:
                    prefix = f'{uuid_variant}_blockhead_'.encode('utf-8')
                    cursor = txn.cursor(main_db)
                    if cursor.set_range(prefix):
                        while True:
                            key = cursor.key()
                            if not key.startswith(prefix):
                                break
                            if key.endswith(suffix):
                                value = cursor.value()
                                if value:
                                    for item_id, count in parse_inventory_plist(value).items():
                                        combined[item_id] = combined.get(item_id, 0) + count
                            if not cursor.next():
                                break
                    cursor.close()
                    if combined:
                        break
        except Exception as e:
            print(f'[WorldManager] get_inventory_counts error for {player_uuid}: {e}')
        return combined

    def get_blockhead_inventory_counts(self, player_uuid: str, blockhead_id: int) -> dict:
        """Get inventory item counts for a specific blockhead."""
        uuid_variants = [player_uuid, player_uuid.replace('-', '')]
        suffix = f'_blockhead_{blockhead_id}_inventory'.encode('utf-8')
        try:
            with self._read_txn() as (txn, main_db):
                for uuid_variant in uuid_variants:
                    key = uuid_variant.encode('utf-8') + suffix
                    value = txn.get(key, db=main_db)
                    if value:
                        return parse_inventory_plist(value)
        except Exception as e:
            print(f'[WorldManager] get_blockhead_inventory_counts error for blockhead {blockhead_id}: {e}')
        return {}

    # -----------------------------------------------------------------------
    # Public API — owner lookup
    # -----------------------------------------------------------------------

    def find_owner(self, blockhead_id, candidate_uuids):
        """Find which player UUID owns a blockhead by checking inventory key existence.

        Returns the matching UUID string, or None.
        """
        from fast_owner_lookup import build_candidates
        ordered = build_candidates(candidate_uuids)
        if not ordered:
            return None
        try:
            with self._read_txn() as (txn, main_db):
                for player_uuid in ordered:
                    key = f"{player_uuid}_blockhead_{blockhead_id}_inventory".encode('utf-8')
                    if txn.get(key, db=main_db):
                        return player_uuid
        except Exception:
            pass
        return None
