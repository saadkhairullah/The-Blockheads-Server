#!/usr/bin/env python3
"""Admin utility: clear all items from a blockhead's inventory."""

from gameSave import GameSave


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


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Clear a blockhead's inventory")
    parser.add_argument("--save-path", required=True, help="Path to world save")
    parser.add_argument("--output-path", required=True, help="Path to save modified world")
    parser.add_argument("--player-uuid", required=True, help="Player UUID")
    parser.add_argument("--blockhead-id", type=int, required=True, help="Blockhead ID")
    args = parser.parse_args()

    gs = GameSave.load(args.save_path)
    ok = clear_inventory(gs, args.player_uuid, args.blockhead_id,
                         save=True, output_path=args.output_path)
    raise SystemExit(0 if ok else 1)
