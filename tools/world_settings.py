"""World settings utilities (worldv2 read/write)."""


def get_worldv2(gs):
    """Return the worldv2 dict from main DB, unwrapping wrappers if needed."""
    main_db = gs._data["world_db"][b"main"]
    world = main_db.get(b"worldv2")
    print("Raw worldv2 type:", world)
    if hasattr(world, '_data'):
        world = world._data
    if isinstance(world, list) and len(world) > 0:
        world = world[0]
        if hasattr(world, '_data'):
            world = world._data
    if not isinstance(world, dict):
        raise ValueError("worldv2 data is not a dict")
    return world


def set_expert_mode(gs, enabled):
    """Toggle expert mode in worldv2."""
    world = get_worldv2(gs)
    before = world.get('expertMode')
    world['expertMode'] = bool(enabled)
    print(f"Expert mode: {before} -> {world['expertMode']}")


def set_portal_level(gs, level):
    """Set the portal level in worldv2."""
    world = get_worldv2(gs)
    before = world.get('portalLevel')
    world['portalLevel'] = int(level)
    print(f"Portal level: {before} -> {world['portalLevel']}")
