"""Item creation and basket/chest slot manipulation utilities."""

import struct
from item import Item
from itemType import ItemExtra, id_to_item_name


def make_item(item_id, count, damage=None, color=None, level=None):
    """Create an Item with the given id and count.

    Optional:
        damage: uint16 durability value (0=full, 16000=broken)
        color:  int or list of up to 4 nibble values (0-15) for color channels
        level:  workbench level (int); init_extra(WORKBENCH) is called automatically.
    """
    raw = struct.pack('<HHH', item_id, 1, 0) + b'\x00\x00'
    item = Item([raw])
    item.count = count
    if damage is not None:
        item.set_damage(int(damage))
    if color is not None:
        if isinstance(color, (list, tuple)):
            item.set_color(*color)
        else:
            item.set_color(int(color))
    if level is not None:
        item.init_extra(ItemExtra.WORKBENCH)
        item.set_level(int(level))
    return item


def get_basket_slots(item_obj):
    """Extract the basket storage slots list from a basket Item, or None if unavailable."""
    if not item_obj.items[0].has_extra:
        return None
    extra = item_obj.items[0]._zip._data[0]
    if hasattr(extra, '_data'):
        extra = extra._data
    if not isinstance(extra, dict) or 's' not in extra:
        return None
    return extra['s']


def set_basket_slots(item_obj, slots):
    """Write back the basket storage slots into the item's internal structure."""
    extra = item_obj.items[0]._zip._data[0]
    if hasattr(extra, '_data'):
        extra._data['s'] = slots
    else:
        extra['s'] = slots


def get_slot_item(slot):
    """Normalize a basket slot (Item or raw list) into an Item, or None if empty/invalid."""
    if isinstance(slot, Item) and slot.count > 0:
        return slot
    if isinstance(slot, list) and len(slot) > 0:
        try:
            return Item(slot)
        except Exception:
            return None
    return None


def get_item_name(item_id):
    """Get item name from ItemType enum."""
    try:
        return id_to_item_name(item_id).replace('_', ' ').title()
    except (KeyError, AttributeError):
        return f"Unknown_Item_{item_id}"
