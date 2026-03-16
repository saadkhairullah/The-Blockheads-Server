# encoding: utf-8
import os
import pathlib
import lmdb
from typing import Dict, Any, Self
from bplist import BPList
from gzipWrapper import GzipWrapper
from bh_chunk import Chunk
from block import Block
from exportable import Exportable
from dataclasses import dataclass
from lmdb_parser import parse_value as _parse_value


@dataclass
class SaveSummary:
    world_name: str
    start_portal_pos: tuple[int, int]
    seed: int
    world_width_in_chunks: int
    expert_mode: bool


class GameSave:
    """
    The class describes the save file of a world. This abstracts save file to
    a simple class, and isolated instructions like creating lmdb context,
    manipulating cursors, and loading and saving BPLists, etc. It also
    provides methods to load and save GameSave within one method call. On top
    of these, methods for manipulating chunks, blocks and dynamic objects
    will be offered.
    """

    MAX_DBS = 100
    # Default to a large mapsize to avoid MDB_MAP_RESIZED on busy worlds
    MIN_MAP_SIZE = 6 * 1024 * 1024 * 1024  # 6 GB
    MAP_SIZE_MULTIPLIER = 4
    MAP_SIZE_PADDING = 8 * 1024 * 1024

    def __init__(self, folder_path: str, is_server_save=True, lite_mode=False):
        if not folder_path.endswith("/"):
            folder_path += "/"
        self._data: dict[str, Any] = {}
        self._lite_mode = lite_mode
        # In lite_mode, skip lightBlocks entirely (not needed for inventory ops)
        sub_dirs = ["world_db", "server_db"] if lite_mode else ["world_db", "server_db", "lightBlocks"]
        for sub_dir in sub_dirs:
            full_path = folder_path + sub_dir
            if os.path.isdir(full_path):
                self._data[sub_dir] = {}
                # In lite_mode, skip heavy sub-dbs not needed for inventory ops:
                # - blocks: chunk data (12+ MB)
                # - dw: dynamic world data (31+ MB)
                # Only 'main' (0.4 MB) is needed for inventory operations
                skip_sub_dbs = {b'blocks', b'dw'} if lite_mode else set()
                self._read_env(full_path, self._data[sub_dir], skip_sub_dbs=skip_sub_dbs)
        self.is_server_save = is_server_save

    def chunks(self):
        return (
            self._data["world_db"][b"blocks"]
            if self.is_server_save
            else self._data["world_db"]["blocks"]
        )

    def __repr__(self):
        return repr(self._data)

    def __getitem__(self, key):
        return self._data[key]

    def __setitem__(self, key, value):
        self._data[key] = value

    def _read_env(self, path: str, dict_: dict[str, Any], skip_sub_dbs: set = None):
        """Read all databases in LMDB Environment from given path, and write
        key-value pairs into `dict_`.

        Args:
            skip_sub_dbs: Set of sub-database names (bytes) to skip loading.
                         Used in lite_mode to skip large data like 'blocks'.
        """
        if skip_sub_dbs is None:
            skip_sub_dbs = set()
        # Use a large map_size to avoid MDB_MAP_RESIZED when the file grows elsewhere.
        env = lmdb.open(path, readonly=True, max_dbs=self.MAX_DBS, map_size=self.MIN_MAP_SIZE)
        try:
            with env.begin() as txn:
                for k, _ in txn.cursor():
                    if k in skip_sub_dbs:
                        continue  # Skip large/unnecessary sub-databases
                    sub_db = env.open_db(k, txn=txn, create=False)
                    dict_[k] = {}
                    self._read_db(txn, sub_db, dict_[k])
        finally:
            env.close()

    def _read_db(self, txn, db, dict_):
        """
        Write all key-value pairs in db into dict_, given transaction, db and
        dict_.
        """
        for k, v in txn.cursor(db):
            dict_[k] = self._parse(v)

    def _parse(self, src):
        return _parse_value(src)

    @classmethod
    def load(cls, path: str) -> Self:
        """Read save files according to the input path, and return a new
        `GameSave` object for furthur operations."""
        return cls(path)

    @classmethod
    def load_lite(cls, path: str) -> Self:
        """Load save in lite mode - skips lightBlocks and blocks data.

        Use this for inventory operations where chunk data isn't needed.
        Significantly reduces memory usage (skips ~50-80% of data).
        """
        return cls(path, lite_mode=True)

    def _export_db(self, dict_, result_dict):
        for k, v in dict_.items():
            if isinstance(v, Exportable):
                result_dict[k] = v.export()

    def _write_db(self, cursor, dict_):
        for k, v in dict_.items():
            cursor.put(k, v)

    def _write_env(self, path: str, dict_: Dict[str, Any]):
        if not os.path.exists(path):
            pathlib.Path(path).mkdir(parents=True, exist_ok=True)
        db_data = {}
        size = 0
        for db in dict_:
            db_data[db] = {}
            self._export_db(dict_[db], db_data[db])
            for k, v in db_data[db].items():
                size += len(k) + len(v)
        map_size = max(size * self.MAP_SIZE_MULTIPLIER + self.MAP_SIZE_PADDING, self.MIN_MAP_SIZE)
        env = lmdb.open(path, map_size=map_size, max_dbs=self.MAX_DBS)
        try:
            with env.begin(write=True) as txn:
                for k, v in db_data.items():
                    sub_db = env.open_db(k, txn=txn, create=True)
                    cursor = txn.cursor(sub_db)
                    self._write_db(cursor, db_data[k])
        finally:
            env.close()

    def save(self, path: str) -> None:
        """Save the world to the given path. Existing files would be overwrite."""
        for env in self._data:
            self._write_env(os.path.join(path, env), self._data[env])

    def world_v2(self) -> Dict[str, Any]:
        return (
            self._data["world_db"][b"main"][b"worldv2"]
            if self.is_server_save
            else self._data["world_db"]["main"]["worldv2"]
        )

    def world_name(self) -> str:
        return self.world_v2()["worldName"]

    def set_world_name(self, name: str):
        self.world_v2()["worldName"] = name

    def save_id(self) -> str:
        return self.world_v2()["saveID"]

    def set_save_id(self, id: str):
        self.world_v2()["saveID"] = id

    def get_summary(self) -> SaveSummary:
        world_v2 = self.world_v2()
        return SaveSummary(
            world_name=world_v2["worldName"],
            start_portal_pos=(
                world_v2["startPortalPos.x"],
                world_v2["startPortalPos.y"],
            ),
            seed=world_v2["randomSeed"],
            world_width_in_chunks=world_v2["worldWidthMacro"],
            expert_mode=world_v2["expertMode"],
        )

    def world_width(self) -> int:
        return self.world_v2()["worldWidthMacro"]

    def _get_chunk_name(self, x: int, y: int) -> bytes | str:
        return (b"%d_%d" if self.is_server_save else "%d_%d") % (x, y)

    def get_chunk(self, x: int, y: int) -> Chunk:
        assert 0 <= x < self.world_width() and 0 <= y < 32
        name = self._get_chunk_name(x, y)
        chunks = self.chunks()
        if name not in chunks:
            chunks[name] = Chunk.create()
        if not isinstance(chunks[name], Chunk):
            chunks[name] = Chunk(chunks[name]._data[0])
        return chunks[name]

    def set_chunk(self, x: int, y: int, c: Chunk):
        assert 0 <= x < self.world_width() and 0 <= y < 32
        chunks = self.chunks()
        chunks[self._get_chunk_name(x, y)] = c

    def get_chunks(self) -> list[tuple[int, ...]]:
        return [
            tuple(map(int, name.split(b"_" if self.is_server_save else "_")))
            for name in self.chunks()
        ]

    def get_block(self, x: int, y: int) -> Block:
        assert 0 <= x < (self.world_width() << 5) and 0 <= y < 1024
        name = self._get_chunk_name(x >> 5, y >> 5)
        chunks = self.chunks()
        if name not in chunks:
            chunks[name] = Chunk.create()
        if not isinstance(chunks[name], Chunk):
            chunks[name] = Chunk(chunks[name]._data[0])
        return chunks[name].get_block(x & 31, y & 31)



if __name__ == "__main__":
    import argparse
    from blockType import BlockType

    parser = argparse.ArgumentParser(description="GameSave example - place time crystals in a region")
    parser.add_argument("--save-path", required=True, help="Path to world save folder")
    args = parser.parse_args()

    gs = GameSave(args.save_path, is_server_save=True)

    x1, y1 = 69126, 486
    x2, y2 = 69130, 490
    count = 0
    for x in range(x1, x2 + 1):
        for y in range(y1, y2 + 1):
            block = gs.get_block(x, y)
            block.set_fg_type(BlockType.TIME_CRYSTAL)
            count += 1
    print(f"Placed {count} time crystals from ({x1},{y1}) to ({x2},{y2})")
    print("saving...")
    gs.save(args.save_path)
    print("done.")
  
