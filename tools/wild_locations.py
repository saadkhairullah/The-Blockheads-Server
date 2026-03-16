#!/usr/bin/env python3
"""
Wild Location Finder for Blockheads World Saves

Finds random tree locations that are NOT near protection signs.
Used by the /wild command to teleport players to wilderness areas.

Uses random chunk sampling for speed - doesn't load entire dw database.

USAGE:
    python3 wild_locations.py --find-location
    python3 wild_locations.py --list-claims
"""

import sys
import json
import random
import argparse
import lmdb
import time
import os
from lmdb_parser import parse_value, unwrap

SAVE_PATH = None

# Protection sign radius (fixed at 30 per server rules)
PROTECTION_RADIUS = 30

# How many chunks to sample before giving up
MAX_CHUNKS_TO_SAMPLE = 200

# Cache claims list to avoid frequent LMDB reads
CLAIMS_CACHE_PATH = "./data/claims_cache.json"
CLAIMS_CACHE_TTL_SEC = 15 * 60



def is_tree(obj_data):
    """Check if a dynamic object is a tree."""
    if not isinstance(obj_data, dict):
        return False
    if obj_data.get('frozen'):
        return False
    keys = set(obj_data.keys())
    # Trees have these keys
    tree_keys = {'age', 'maxAge', 'growthRate', 'availableFood', 'seasonOffset'}
    # Animals have these keys (exclude them)
    animal_keys = {'tameCooldownTimer', 'fullness', 'breed', 'frozen'}

    has_tree_keys = len(tree_keys & keys) >= 3
    has_animal_keys = len(animal_keys & keys) >= 2

    return has_tree_keys and not has_animal_keys


def is_protection_sign(obj_data):
    """Check if a dynamic object is a protection sign."""
    if not isinstance(obj_data, dict):
        return False
    return obj_data.get('interactionObjectType') == 8


def is_in_claim(x, y, claims, radius=PROTECTION_RADIUS):
    """Check if a position is within any claim's protection radius."""
    for claim in claims:
        claim_x = claim['x']
        claim_y = claim['y']
        if (abs(x - claim_x) <= radius and
            abs(y - claim_y) <= radius):
            return True
    return False


def extract_signs(obj, out):
    if isinstance(obj, dict):
        pos = None
        if "pos" in obj:
            pos = obj.get("pos")
        elif "x" in obj and "y" in obj:
            pos = (obj.get("x"), obj.get("y"))
        if pos is not None:
            out.append(pos)
        for v in obj.values():
            extract_signs(v, out)
    elif isinstance(obj, list):
        for v in obj:
            extract_signs(v, out)


def load_claims_from_sign_db(save_path):
    claims = []
    db_path = save_path + "world_db"
    try:
        env = lmdb.open(db_path, readonly=True, max_dbs=64, lock=False, readahead=False)
        try:
            db_main = env.open_db(b"main")
            with env.begin(db=db_main) as txn:
                raw = txn.get(b"signOwnershipData")
                if not raw:
                    return []
                data = unwrap(parse_value(raw))
                positions = []
                extract_signs(data, positions)
                for pos in positions:
                    if isinstance(pos, (list, tuple)) and len(pos) >= 2:
                        claims.append({'x': int(pos[0]), 'y': int(pos[1])})
        finally:
            env.close()
    except Exception as e:
        sys.stderr.write(f"Error reading signOwnershipData: {e}\n")
    return claims


def get_claims_cached(save_path, claims_cache_path=None):
    cache_path = claims_cache_path or CLAIMS_CACHE_PATH
    try:
        if (os.path.exists(cache_path) and
            (time.time() - os.path.getmtime(cache_path)) < CLAIMS_CACHE_TTL_SEC):
            with open(cache_path, "r") as f:
                return json.load(f)
    except Exception:
        pass
    claims = load_claims_from_sign_db(save_path)
    try:
        cache_dir = os.path.dirname(cache_path)
        if cache_dir:
            os.makedirs(cache_dir, exist_ok=True)
        with open(cache_path, "w") as f:
            json.dump(claims, f)
    except Exception:
        pass
    return claims


def get_all_claims_fast(save_path, claims_cache_path=None):
    """Fetch all protection signs from signOwnershipData (main db)."""
    return get_claims_cached(save_path, claims_cache_path)


def find_wild_location_fast(save_path, min_y=521, max_y=600, spawn_x=78405, min_spawn_distance=5000, claims_cache_path=None):
    """
    Find a random tree location using random chunk sampling.

    Only parses sampled chunks - collects both protection signs and trees.
    Much faster than scanning entire dw database.
    """
    db_path = save_path + "world_db"

    env = None
    try:
        env = lmdb.open(db_path, readonly=True, max_dbs=100, map_size=6 * 1024 * 1024 * 1024)

        # First: just get all chunk keys (no parsing - very fast)
        chunk_keys = []
        with env.begin() as txn:
            dw_db = env.open_db(b"dw", txn=txn, create=False)
            cursor = txn.cursor(dw_db)
            for key, _ in cursor:
                chunk_keys.append(key)

        sys.stderr.write(f"Found {len(chunk_keys)} chunks, sampling randomly...\n")

        # Shuffle for true randomness
        random.shuffle(chunk_keys)

        # Use signOwnershipData claims (no DW scan for signs)
        claims = get_claims_cached(save_path, claims_cache_path)
        candidate_trees = []
        chunks_sampled = 0

        with env.begin() as txn:
            dw_db = env.open_db(b"dw", txn=txn, create=False)

            for key in chunk_keys:
                if chunks_sampled >= MAX_CHUNKS_TO_SAMPLE:
                    break

                chunks_sampled += 1
                raw_value = txn.get(key, db=dw_db)
                if not raw_value:
                    continue

                try:
                    data = parse_value(raw_value)
                    data = unwrap(data)
                    if not isinstance(data, dict):
                        continue

                    for obj in data.get('dynamicObjects', []):
                        obj_data = unwrap(obj)

                        # Collect trees in valid y range
                        if is_tree(obj_data):
                            pos_x = obj_data.get('pos_x', 0)
                            pos_y = obj_data.get('pos_y', 0)
                            if min_y <= pos_y <= max_y:
                                candidate_trees.append({'x': pos_x, 'y': pos_y})
                except Exception:
                    continue

        sys.stderr.write(f"Sampled {chunks_sampled} chunks: {len(candidate_trees)} trees, {len(claims)} claims\n")

        # Filter trees that aren't in claims and aren't too close to spawn
        valid_trees = [t for t in candidate_trees
                       if not is_in_claim(t['x'], t['y'], claims)
                       and abs(t['x'] - spawn_x) >= min_spawn_distance]

        if not valid_trees:
            return {
                'success': False,
                'error': 'No valid wild locations found in sampled chunks',
                'chunks_sampled': chunks_sampled,
                'trees_found': len(candidate_trees),
                'claims_found': len(claims)
            }

        # Pick a truly random tree
        chosen = random.choice(valid_trees)

        return {
            'success': True,
            'x': chosen['x'],
            'y': chosen['y'],
            'chunks_sampled': chunks_sampled,
            'valid_locations': len(valid_trees),
            'claims_found': len(claims)
        }

    except Exception as e:
        return {
            'success': False,
            'error': str(e)
        }
    finally:
        if env is not None:
            try:
                env.close()
            except Exception:
                pass


def list_claims(save_path):
    """List all protection signs/claims."""
    claims = get_all_claims_fast(save_path)

    print(f"Found {len(claims)} protection signs:")
    print()
    for claim in claims:
        print(f"  x={claim['x']:6d}, y={claim['y']:3d}, "
              f"size={claim['w']}x{claim['h']}, owner={claim.get('ownerName', 'Unknown')}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Find wild locations in Blockheads world")
    parser.add_argument("--find-location", action="store_true",
                        help="Find a random wild location (JSON output)")
    parser.add_argument("--list-claims", action="store_true",
                        help="List protection signs/claims")
    parser.add_argument("--save-path", required=True,
                        help="Path to world save folder")
    parser.add_argument("--claims-cache-path", default=CLAIMS_CACHE_PATH,
                        help="Path to claims cache JSON file (default: ./data/claims_cache.json)")
    parser.add_argument("--min-y", type=int, default=521,
                        help="Minimum Y coordinate for wild location")
    parser.add_argument("--max-y", type=int, default=600,
                        help="Maximum Y coordinate for wild location")
    parser.add_argument("--spawn-x", type=int, default=78405,
                        help="Spawn X coordinate to avoid")
    parser.add_argument("--min-spawn-distance", type=int, default=5000,
                        help="Minimum distance from spawn X")

    args = parser.parse_args()

    if args.find_location:
        result = find_wild_location_fast(args.save_path, args.min_y, args.max_y, args.spawn_x, args.min_spawn_distance, args.claims_cache_path)
        print(json.dumps(result))
    elif args.list_claims:
        list_claims(args.save_path)
    else:
        # Default: find location
        result = find_wild_location_fast(args.save_path, args.min_y, args.max_y, args.spawn_x, args.min_spawn_distance, args.claims_cache_path)
        print(json.dumps(result))
