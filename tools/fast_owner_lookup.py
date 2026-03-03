#!/usr/bin/env python3
import argparse
import json
import lmdb
import os
import sys

# Takes the list of candidate PlayerIds/Online Players, and looks for a specific blockhead inventory key in
# the world_db LMDB, in the "main" file. If it finds a match, it returns that PlayerId as the owner of the blockhead.


def build_candidates(raw_candidates):
    variants = []
    for u in raw_candidates or []:
        if not u:
            continue
        u = str(u).strip()
        if not u:
            continue
        variants.append(u)
        low = u.lower()
        if low != u:
            variants.append(low)
        nodash = u.replace("-", "")
        if nodash != u:
            variants.append(nodash)
        nodash_low = nodash.lower()
        if nodash_low != nodash:
            variants.append(nodash_low)
    seen = set()
    ordered = []
    for u in variants:
        if u in seen:
            continue
        seen.add(u)
        ordered.append(u)
    return ordered


def main():
    parser = argparse.ArgumentParser(description="Fast owner lookup for blockhead using LMDB key existence")
    parser.add_argument("--save-path", required=True, help="Path to world save directory")
    parser.add_argument("--blockhead-id", required=True, type=int, help="Blockhead ID to resolve")
    parser.add_argument("--candidate-uuids-json", required=True, help="JSON array of candidate UUIDs")
    args = parser.parse_args()

    try:
        candidates = json.loads(args.candidate_uuids_json)
        if not isinstance(candidates, list):
            raise ValueError("candidate-uuids-json must be a JSON array")
    except Exception as e:
        print(json.dumps({"ok": False, "error": f"bad candidates: {e}"}))
        return 1

    db_path = os.path.join(args.save_path, "world_db")
    if not os.path.isdir(db_path):
        print(json.dumps({"ok": False, "error": f"world_db not found at {db_path}"}))
        return 1

    ordered = build_candidates(candidates)
    if not ordered:
        print(json.dumps({"ok": True, "playerUuid": None}))
        return 0

    try:
        env = lmdb.open(db_path, readonly=True, max_dbs=100, lock=False)
        with env.begin() as txn:
            main_db = env.open_db(b"main", txn=txn, create=False)
            for player_uuid in ordered:
                key = f"{player_uuid}_blockhead_{args.blockhead_id}_inventory".encode("utf-8")
                raw = txn.get(key, db=main_db)
                if raw:
                    print(json.dumps({"ok": True, "playerUuid": player_uuid}))
                    return 0
    except Exception as e:
        print(json.dumps({"ok": False, "error": str(e)}))
        return 1
    finally:
        try:
            env.close()
        except Exception:
            pass

    print(json.dumps({"ok": True, "playerUuid": None}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
