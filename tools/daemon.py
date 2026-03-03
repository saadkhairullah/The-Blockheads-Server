"""Daemon mode: persistent process that keeps LMDB open and processes JSON commands from stdin."""

import os
import sys
import json
import time
import select

from gameSave import GameSave
from lmdb_parser import parse_value
import lmdb

from inventory_ops import (
    find_player_uuid_for_blockhead,
    inventory_has_space,
    get_inventory_counts,
    get_all_blockhead_inventory_counts,
)
from targeted_lmdb_ops import (
    _sync_gs_inventory_key,
    apply_quest_items_targeted,
    give_item_to_blockhead,
    take_item_from_blockhead,
    teleport_blockhead_targeted,
)


def run_daemon(save_path, auto_save_interval=10):
    """
    Daemon mode: Keep LMDB open and process commands from stdin.
    Each line is a JSON command, responses are JSON on stdout.

    KEY OPTIMIZATION: Write operations modify memory only. Saves are batched:
    - Auto-save every N seconds if dirty
    - Explicit {"op": "save"} to force immediate save
    - This turns 10 separate saves into 1 batched save!

    Commands:
      READ (no save needed):
        {"op": "list-blockheads", "playerUuid": "..."}
        {"op": "find-blockhead-owner", "blockheadId": 123}
        {"op": "inventory-counts", "blockheadId": 123}
        {"op": "player-inventory-counts", "playerUuid": "..."}

      WRITE (deferred save by default):
        {"op": "give-item", "blockheadId": 123, "itemId": 45, "count": 1}
        {"op": "take-item", "blockheadId": 123, "itemId": 45, "count": 1}
        {"op": "apply-quest-items", "blockheadId": 123, "removeItems": [...], "giveItems": [...]}

      CONTROL:
        {"op": "save"}           # Force immediate save to disk
        {"op": "save-if-dirty"}  # Save only if there are pending changes
        {"op": "reload"}         # Reload from disk (discards unsaved changes!)
        {"op": "status"}         # Get daemon status (dirty, pending ops, etc)
        {"op": "ping"}           # Health check
        {"op": "quit"}           # Save and exit
        {"op": "batch", "commands": [...]}  # Multiple ops, single response
    """

    gs = None
    dirty = False
    last_save_time = 0
    pending_write_count = 0

    # Index for O(1) blockhead -> owner lookups (built at startup, updated on list-blockheads)
    blockhead_to_owner = {}
    # Reverse index for O(1) owner -> blockheads lookups
    owner_to_blockheads = {}

    # -------------------------------------------------------------------------
    # Internal helpers (access nonlocal state)
    # -------------------------------------------------------------------------

    def refresh_key_from_disk(key_bytes):
        """Refresh a single key from LMDB without reloading entire save."""
        env = None
        try:
            db_path = os.path.join(save_path, "world_db")
            env = lmdb.open(db_path, readonly=True, max_dbs=100, map_size=8 * 1024 * 1024 * 1024, lock=False)
            with env.begin() as txn:
                main_db = env.open_db(b"main", txn=txn, create=False)
                raw_value = txn.get(key_bytes, db=main_db)
                if raw_value:
                    parsed = parse_value(raw_value)
                    gs._data["world_db"][b"main"][key_bytes] = parsed
                    sys.stderr.write(f"[daemon] Refreshed key {key_bytes[:50]}... from disk\n")
                    sys.stderr.flush()
                    return True
            return False
        except Exception as e:
            sys.stderr.write(f"[daemon] Error refreshing key from disk: {e}\n")
            sys.stderr.flush()
            return False
        finally:
            if env:
                try:
                    env.close()
                except Exception:
                    pass

    def build_blockhead_index(gs_ref):
        """Build bidirectional indexes from all inventory keys. Called once at startup."""
        nonlocal blockhead_to_owner, owner_to_blockheads
        blockhead_to_owner = {}
        owner_to_blockheads = {}
        main_db = gs_ref._data["world_db"][b"main"]
        count = 0
        for key in main_db.keys():
            try:
                key_str = key.decode('utf-8', errors='ignore')
            except Exception:
                continue
            if "_blockhead_" in key_str and key_str.endswith("_inventory"):
                try:
                    parts = key_str.split("_blockhead_")
                    player_uuid = parts[0]
                    blockhead_id = int(parts[1].replace("_inventory", ""))
                    blockhead_to_owner[blockhead_id] = player_uuid
                    if player_uuid not in owner_to_blockheads:
                        owner_to_blockheads[player_uuid] = []
                    owner_to_blockheads[player_uuid].append(blockhead_id)
                    count += 1
                except (ValueError, IndexError):
                    continue
        sys.stderr.write(f"[daemon] Built blockhead index: {count} blockheads mapped, {len(owner_to_blockheads)} players\n")
        sys.stderr.flush()

    def lookup_player_blockheads(player_uuid):
        """Fast targeted lookup for a single player's blockheads.
        Scans only keys starting with this player's UUID.
        Updates the indexes and returns the blockhead IDs found.
        """
        nonlocal blockhead_to_owner, owner_to_blockheads
        if gs is None:
            return []

        main_db = gs._data["world_db"][b"main"]
        uuid_variants = [player_uuid, player_uuid.replace('-', '')]
        found_ids = []

        for uuid in uuid_variants:
            prefix = f"{uuid}_blockhead_".encode('utf-8')
            for key in main_db.keys():
                try:
                    if key.startswith(prefix) and key.endswith(b"_inventory"):
                        key_str = key.decode('utf-8', errors='ignore')
                        parts = key_str.split("_blockhead_")
                        blockhead_id = int(parts[1].replace("_inventory", ""))
                        if blockhead_id not in found_ids:
                            found_ids.append(blockhead_id)
                            blockhead_to_owner[blockhead_id] = uuid
                except Exception:
                    continue

            if found_ids:
                owner_to_blockheads[uuid] = found_ids
                sys.stderr.write(f"[daemon] Found {len(found_ids)} blockheads for player {uuid[:8]}...\n")
                sys.stderr.flush()
                return found_ids

        return []

    def load_save(save_pending=True):
        nonlocal gs, dirty, last_save_time, pending_write_count
        if dirty and gs is not None:
            if save_pending:
                sys.stderr.write(f"[daemon] Saving {pending_write_count} pending ops before reload...\n")
                sys.stderr.flush()
                gs.save(save_path)
            else:
                sys.stderr.write(f"[daemon] Discarding {pending_write_count} pending ops on reload...\n")
                sys.stderr.flush()
        gs = GameSave.load_lite(save_path)
        dirty = False
        last_save_time = time.time()
        pending_write_count = 0
        build_blockhead_index(gs)
        return gs

    def do_save():
        nonlocal dirty, last_save_time, pending_write_count
        if gs is None:
            return False
        gs.save(save_path)
        dirty = False
        last_save_time = time.time()
        saved_count = pending_write_count
        pending_write_count = 0
        sys.stderr.write(f"[daemon] Saved {saved_count} pending operations\n")
        sys.stderr.flush()
        return True

    def mark_dirty():
        nonlocal dirty, pending_write_count
        dirty = True
        pending_write_count += 1

    last_db_warning_time = [0]

    def check_db_size(log_warning=True):
        try:
            db_file = os.path.join(save_path, "world_db", "data.mdb")
            if os.path.exists(db_file):
                size_bytes = os.path.getsize(db_file)
                size_mb = size_bytes / (1024 * 1024)
                if size_mb > 900:
                    if log_warning and (time.time() - last_db_warning_time[0]) > 300:
                        last_db_warning_time[0] = time.time()
                        sys.stderr.write(f"[daemon] WARNING: Database size is {size_mb:.0f}MB - approaching 1GB limit! Server restart needed soon.\n")
                        sys.stderr.flush()
                    return {"warning": True, "size_mb": size_mb, "message": "Database approaching 1GB limit - restart server to auto-resize"}
                return {"warning": False, "size_mb": size_mb}
        except Exception as e:
            sys.stderr.write(f"[daemon] Error checking DB size: {e}\n")
            sys.stderr.flush()
        return {"warning": False, "size_mb": 0}

    # -------------------------------------------------------------------------
    # Command processor
    # -------------------------------------------------------------------------

    def process_command(cmd, gs_ref):
        """Process a single command and return result dict."""
        nonlocal dirty
        op = cmd.get("op")

        # --- Control commands ---
        if op == "ping":
            return {"ok": True, "op": "ping"}

        if op == "status":
            db_status = check_db_size()
            return {
                "ok": True,
                "op": "status",
                "dirty": dirty,
                "pendingWrites": pending_write_count,
                "lastSaveSecondsAgo": int(time.time() - last_save_time),
                "autoSaveInterval": auto_save_interval,
                "dbSizeMB": db_status.get("size_mb", 0),
                "dbWarning": db_status.get("warning", False),
                "dbMessage": db_status.get("message")
            }

        if op == "save":
            do_save()
            return {"ok": True, "op": "save", "saved": True}

        if op == "save-if-dirty":
            if dirty:
                do_save()
                return {"ok": True, "op": "save-if-dirty", "saved": True}
            return {"ok": True, "op": "save-if-dirty", "saved": False, "reason": "not dirty"}

        if op == "reload":
            load_save(save_pending=False)
            return {"ok": True, "op": "reload"}

        # --- Read commands ---
        if op == "list-blockheads":
            player_uuid = cmd.get("playerUuid")
            if not player_uuid:
                return {"error": "Missing playerUuid"}
            uuid_nodash = player_uuid.replace('-', '')
            ids = owner_to_blockheads.get(player_uuid) or owner_to_blockheads.get(uuid_nodash)
            if ids:
                return {"ok": True, "playerUuid": player_uuid, "blockheadIds": list(ids)}
            ids = lookup_player_blockheads(player_uuid)
            return {"ok": True, "playerUuid": player_uuid, "blockheadIds": list(ids)}

        if op == "list-blockheads-with-names":
            player_uuid = cmd.get("playerUuid")
            if not player_uuid:
                return {"error": "Missing playerUuid"}
            uuid_nodash = player_uuid.replace('-', '')
            bh_key = f"{uuid_nodash}_blockheads".encode('utf-8')
            refresh_key_from_disk(bh_key)
            main_db = gs_ref._data["world_db"][b"main"]
            if bh_key not in main_db:
                return {"ok": True, "blockheads": []}
            try:
                bh_wrapper = main_db[bh_key]
                bh_data = bh_wrapper._data[0]._data
                if not isinstance(bh_data, dict):
                    return {"ok": True, "blockheads": []}
                result = []
                for obj in bh_data.get('dynamicObjects', []):
                    obj_data = obj
                    if hasattr(obj_data, '_data'): obj_data = obj_data._data
                    if isinstance(obj_data, list) and len(obj_data) == 1:
                        obj_data = obj_data[0]
                        if hasattr(obj_data, '_data'): obj_data = obj_data._data
                    if isinstance(obj_data, dict):
                        result.append({"blockheadId": obj_data.get('uniqueID'), "name": obj_data.get('name', 'Unknown')})
                return {"ok": True, "blockheads": result}
            except Exception as e:
                return {"ok": False, "error": str(e), "blockheads": []}

        if op == "get-full-index":
            return {"ok": True, "index": {k: list(v) for k, v in owner_to_blockheads.items()}}

        if op == "find-blockhead-owner":
            blockhead_id = cmd.get("blockheadId")
            if blockhead_id is None:
                return {"error": "Missing blockheadId"}
            player_uuid = blockhead_to_owner.get(blockhead_id)
            if not player_uuid:
                return {"ok": True, "blockheadId": blockhead_id, "playerUuid": None, "error": "Owner not found"}
            return {"ok": True, "blockheadId": blockhead_id, "playerUuid": player_uuid}

        if op == "inventory-counts":
            blockhead_id = cmd.get("blockheadId")
            if blockhead_id is None:
                return {"error": "Missing blockheadId"}
            # Refresh from disk — gs_ref is stale after game server auto-saves
            _inv_uuid = cmd.get("playerUuid") or blockhead_to_owner.get(blockhead_id)
            if _inv_uuid:
                refresh_key_from_disk(f"{_inv_uuid}_blockhead_{blockhead_id}_inventory".encode('utf-8'))
            counts = get_inventory_counts(save_path, blockhead_id, gs_ref, owner_index=blockhead_to_owner)
            if counts is None:
                player_uuid = cmd.get("playerUuid") or blockhead_to_owner.get(blockhead_id)
                if player_uuid:
                    lookup_player_blockheads(player_uuid)
                    counts = get_inventory_counts(save_path, blockhead_id, gs_ref, owner_index=blockhead_to_owner)
            if counts is None:
                return {"error": "Blockhead not found", "blockheadId": blockhead_id}
            return {"ok": True, "blockheadId": blockhead_id, "items": counts}

        if op == "inventory-has-space":
            blockhead_id = cmd.get("blockheadId")
            player_uuid_override = cmd.get("playerUuid")
            if blockhead_id is None:
                return {"error": "Missing blockheadId"}
            has_space = inventory_has_space(gs_ref, blockhead_id, player_uuid_override, owner_index=blockhead_to_owner)
            if has_space is None:
                player_uuid = player_uuid_override or blockhead_to_owner.get(blockhead_id)
                if player_uuid:
                    lookup_player_blockheads(player_uuid)
                    has_space = inventory_has_space(gs_ref, blockhead_id, player_uuid_override, owner_index=blockhead_to_owner)
            return {"ok": True, "blockheadId": blockhead_id, "hasSpace": bool(has_space)}

        if op == "player-inventory-counts":
            player_uuid = cmd.get("playerUuid")
            if not player_uuid:
                return {"error": "Missing playerUuid"}
            counts = get_all_blockhead_inventory_counts(save_path, player_uuid, gs_ref)
            if not counts:
                lookup_player_blockheads(player_uuid)
                counts = get_all_blockhead_inventory_counts(save_path, player_uuid, gs_ref)
            return {"ok": True, "playerUuid": player_uuid, "items": counts}

        # --- Write commands (targeted LMDB writes) ---
        if op == "give-item":
            return _handle_give_item(cmd, gs_ref)

        if op == "take-item":
            return _handle_take_item(cmd, gs_ref)

        if op == "apply-quest-items":
            return _handle_apply_quest_items(cmd, gs_ref)

        if op == "get-blockhead-position":
            return _handle_get_blockhead_position(cmd, gs_ref)

        if op == "teleport-blockhead":
            return _handle_teleport_blockhead(cmd, gs_ref)

        if op == "batch":
            commands = cmd.get("commands", [])
            results = []
            for sub_cmd in commands:
                results.append(process_command(sub_cmd, gs_ref))
            return {"ok": True, "op": "batch", "results": results, "pending": dirty}

        return {"error": f"Unknown operation: {op}"}

    # -------------------------------------------------------------------------
    # Write command handlers
    # -------------------------------------------------------------------------

    def _resolve_uuid(cmd, blockhead_id):
        """Resolve player UUID from command, index, or slow scan."""
        player_uuid_override = cmd.get("playerUuid")
        player_uuid = player_uuid_override or blockhead_to_owner.get(blockhead_id) or find_player_uuid_for_blockhead(gs, blockhead_id)
        if not player_uuid and player_uuid_override:
            lookup_player_blockheads(player_uuid_override)
            player_uuid = player_uuid_override if blockhead_to_owner.get(blockhead_id) else None
        return player_uuid

    def _handle_give_item(cmd, gs_ref):
        blockhead_id = cmd.get("blockheadId")
        item_id = cmd.get("itemId")
        count = cmd.get("count", 1)
        damage = cmd.get("damage")
        color = cmd.get("color")
        level = cmd.get("level")
        basket_only = bool(cmd.get("basketOnly", False))
        if blockhead_id is None:
            return {"error": "Missing blockheadId"}
        if item_id is None:
            return {"error": "Missing itemId"}

        player_uuid = _resolve_uuid(cmd, blockhead_id)
        if not player_uuid:
            return {"ok": False, "error": "player_uuid_not_found", "op": "give-item", "blockheadId": blockhead_id}

        result = give_item_to_blockhead(save_path, blockhead_id, item_id, count, player_uuid,
                                        damage=damage, color=color, level=level, basket_only=basket_only)
        ok = bool(result)
        if ok:
            world_db_path = os.path.join(save_path, "world_db")
            inv_key = f"{player_uuid}_blockhead_{blockhead_id}_inventory".encode('utf-8')
            _sync_gs_inventory_key(gs_ref, world_db_path, inv_key)
            sys.stderr.write(f"[daemon] Gave {count}x item {item_id} to blockhead {blockhead_id}\n")
        else:
            sys.stderr.write(f"[daemon] Failed to give item {item_id} to blockhead {blockhead_id}\n")
        sys.stderr.flush()
        return {"ok": ok, "op": "give-item", "blockheadId": blockhead_id, "itemId": item_id, "count": count}

    def _handle_take_item(cmd, gs_ref):
        blockhead_id = cmd.get("blockheadId")
        item_id = cmd.get("itemId")
        count = cmd.get("count", 1)
        if blockhead_id is None:
            return {"error": "Missing blockheadId"}
        if item_id is None:
            return {"error": "Missing itemId"}

        player_uuid_override = cmd.get("playerUuid")
        player_uuid = player_uuid_override or blockhead_to_owner.get(blockhead_id)
        if not player_uuid:
            player_uuid = find_player_uuid_for_blockhead(gs, blockhead_id)
        if not player_uuid and player_uuid_override:
            lookup_player_blockheads(player_uuid_override)
            player_uuid = player_uuid_override if blockhead_to_owner.get(blockhead_id) else None

        result = take_item_from_blockhead(save_path, blockhead_id, item_id, count, player_uuid)
        if result.get("success"):
            world_db_path = os.path.join(save_path, "world_db")
            inv_key = f"{player_uuid}_blockhead_{blockhead_id}_inventory".encode('utf-8')
            _sync_gs_inventory_key(gs_ref, world_db_path, inv_key)
            sys.stderr.write(f"[daemon] Took {result.get('taken', 0)}x item {item_id} from blockhead {blockhead_id}\n")
            sys.stderr.flush()
        return result

    def _handle_apply_quest_items(cmd, gs_ref):
        blockhead_id = cmd.get("blockheadId")
        remove_items = cmd.get("removeItems", [])
        give_items = cmd.get("giveItems", [])
        if blockhead_id is None:
            return {"error": "Missing blockheadId"}

        player_uuid = _resolve_uuid(cmd, blockhead_id)
        if not player_uuid:
            return {"success": False, "error": "player_uuid_not_found", "blockheadId": blockhead_id}

        result = apply_quest_items_targeted(save_path, blockhead_id, remove_items, give_items, player_uuid)
        if result.get("success"):
            world_db_path = os.path.join(save_path, "world_db")
            inv_key = f"{player_uuid}_blockhead_{blockhead_id}_inventory".encode('utf-8')
            _sync_gs_inventory_key(gs_ref, world_db_path, inv_key)
            sys.stderr.write(f"[daemon] Applied quest items to blockhead {blockhead_id}\n")
            sys.stderr.flush()
        else:
            sys.stderr.write(f"[daemon] Failed to apply quest items: {result.get('error')}\n")
            sys.stderr.flush()
        return result

    def _handle_get_blockhead_position(cmd, gs_ref):
        blockhead_id = cmd.get("blockheadId")
        if blockhead_id is None:
            return {"error": "Missing blockheadId"}

        player_uuid = _resolve_uuid(cmd, blockhead_id)
        if not player_uuid:
            return {"ok": False, "error": "player_uuid_not_found", "op": "get-blockhead-position", "blockheadId": blockhead_id}

        uuid_nodash = player_uuid.replace('-', '')
        bh_key = f"{uuid_nodash}_blockheads".encode('utf-8')
        refresh_key_from_disk(bh_key)

        main_db = gs_ref._data["world_db"][b"main"]
        if bh_key not in main_db:
            return {"ok": False, "error": "blockheads_key_not_found", "op": "get-blockhead-position", "blockheadId": blockhead_id}

        try:
            bh_wrapper = main_db[bh_key]
            bh_data = bh_wrapper._data[0]._data
            if not isinstance(bh_data, dict):
                return {"ok": False, "error": "invalid_blockheads_data", "op": "get-blockhead-position"}

            dynamic_objects = bh_data.get('dynamicObjects', [])
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
                if obj_data.get('uniqueID') == blockhead_id:
                    pos_x = obj_data.get('pos_x', 0)
                    pos_y = obj_data.get('pos_y', 0)
                    return {"ok": True, "op": "get-blockhead-position", "blockheadId": blockhead_id, "x": pos_x, "y": pos_y}

            return {"ok": False, "error": "blockhead_not_found_in_dynamicObjects", "op": "get-blockhead-position", "blockheadId": blockhead_id}

        except Exception as e:
            sys.stderr.write(f"[daemon] Error getting blockhead position: {e}\n")
            sys.stderr.flush()
            return {"ok": False, "error": str(e), "op": "get-blockhead-position", "blockheadId": blockhead_id}

    def _handle_teleport_blockhead(cmd, gs_ref):
        blockhead_id = cmd.get("blockheadId")
        x = cmd.get("x")
        y = cmd.get("y")
        if blockhead_id is None:
            return {"error": "Missing blockheadId"}
        if x is None or y is None:
            return {"error": "Missing x or y coordinate"}

        player_uuid = _resolve_uuid(cmd, blockhead_id)
        if not player_uuid:
            return {"ok": False, "error": "player_uuid_not_found", "op": "teleport-blockhead", "blockheadId": blockhead_id}

        result = teleport_blockhead_targeted(save_path, player_uuid, blockhead_id, x, y)
        if result.get("ok"):
            bh_key = result.pop("_bh_key", None)
            if bh_key:
                world_db_path = os.path.join(save_path, "world_db")
                _sync_gs_inventory_key(gs_ref, world_db_path, bh_key)
            sys.stderr.write(f"[daemon] Teleported blockhead {blockhead_id} to ({x}, {y})\n")
            sys.stderr.flush()
        result.pop("_bh_key", None)
        result["op"] = "teleport-blockhead"
        return result

    # -------------------------------------------------------------------------
    # Main loop
    # -------------------------------------------------------------------------

    sys.stderr.write(f"[daemon] Loading save from {save_path} (lite mode - skipping blocks/lightBlocks)\n")
    sys.stderr.write(f"[daemon] Auto-save interval: {auto_save_interval} seconds\n")
    sys.stderr.flush()

    db_status = check_db_size()
    if db_status.get("size_mb"):
        sys.stderr.write(f"[daemon] Database size: {db_status['size_mb']:.0f}MB\n")
        sys.stderr.flush()

    load_save()
    sys.stderr.write("[daemon] Ready\n")
    sys.stderr.flush()

    print(json.dumps({"ready": True, "autoSaveInterval": auto_save_interval}), flush=True)

    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 1.0)

        if dirty and (time.time() - last_save_time) >= auto_save_interval:
            sys.stderr.write(f"[daemon] Auto-saving ({pending_write_count} pending ops)...\n")
            sys.stderr.flush()
            do_save()
            check_db_size()

        if not ready:
            continue

        line = sys.stdin.readline()
        if not line:  # EOF
            break

        line = line.strip()
        if not line:
            continue

        try:
            cmd = json.loads(line)
        except json.JSONDecodeError as e:
            print(json.dumps({"error": f"Invalid JSON: {e}"}), flush=True)
            continue

        if cmd.get("op") == "quit":
            if dirty:
                sys.stderr.write(f"[daemon] Saving before quit ({pending_write_count} pending ops)...\n")
                sys.stderr.flush()
                do_save()
            print(json.dumps({"ok": True, "op": "quit"}), flush=True)
            break

        try:
            result = process_command(cmd, gs)
            print(json.dumps(result), flush=True)
        except Exception as e:
            print(json.dumps({"error": str(e), "op": cmd.get("op")}), flush=True)

    sys.stderr.write("[daemon] Exiting\n")
    sys.stderr.flush()
