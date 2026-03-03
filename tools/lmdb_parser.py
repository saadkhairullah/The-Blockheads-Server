"""
Shared LMDB value parsing utilities.

parse_value() is duplicated across gameSave.py (as GameSave._parse),
wild_locations.py, and the daemon module. This module
provides a single authoritative copy.

Used by: world_manager.py, wild_locations.py, daemon.py, targeted_lmdb_ops.py
"""

import plistlib
from gzipWrapper import GzipWrapper
from bplist import BPList


def parse_value(src):
    """Parse LMDB value bytes into Python objects.

    Handles: bplist, gzip-compressed data, xml plist, raw bytes, lists, dicts.
    Same logic as GameSave._parse().
    """
    if isinstance(src, bytes):
        if src.startswith(b"bplist00"):
            result = BPList(plistlib.loads(src), src_type="bp")
            return parse_value(result)
        if src.startswith(b"\x1f\x8b"):
            result = GzipWrapper(src)
            result._data[0] = parse_value(result._data[0])
            return result
        if src.startswith(b"<?xml"):
            try:
                result = BPList(plistlib.loads(src), src_type="xml")
                return parse_value(result)
            except Exception:
                return src
        return src
    elif isinstance(src, list):
        for i, v in enumerate(src):
            src[i] = parse_value(v)
        return src
    elif isinstance(src, dict):
        for k, v in src.items():
            src[k] = parse_value(v)
        return src
    elif isinstance(src, BPList):
        src._data = parse_value(src._data)
        return src
    return src


def unwrap(value):
    """Unwrap GzipWrapper/BPList to get the underlying dict/list data."""
    data = value
    if hasattr(data, '_data'):
        data = data._data
    if isinstance(data, list) and len(data) > 0:
        data = data[0]
        if hasattr(data, '_data'):
            data = data._data
    return data
