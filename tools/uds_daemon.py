#!/usr/bin/env python3
"""
WorldManager UDS daemon.

Persistent Python process that keeps LMDB open and serves JSON requests
from the Node.js bot over a Unix Domain Socket.

Protocol: newline-delimited JSON
  Request:  {"id":"1","cmd":"give_item","blockheadId":123,...}\n
  Response: {"id":"1","ok":true,...}\n

Start:
  python3 uds_daemon.py <save_path>

Socket path (default /tmp/bh-wm.sock) can be overridden via BH_WM_SOCK env var.
"""

import sys
import os
import json
import socket
import signal

TOOLS_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, TOOLS_DIR)

from world_manager_service import WorldManager
from wild_locations import find_wild_location_fast

SOCKET_PATH = os.environ.get('BH_WM_SOCK', '/tmp/bh-wm.sock')


def dispatch(wm: WorldManager, req: dict) -> dict:
    cmd = req.get('cmd', '')
    req_id = req.get('id', '')

    try:
        # --- Read ops (WorldManager persistent env) ---

        if cmd == 'list_blockheads':
            ids = wm.list_blockheads(req['playerUuid'])
            return {'id': req_id, 'ok': True, 'blockheadIds': ids}

        elif cmd == 'inventory_counts':
            items = wm.get_inventory_counts(req['playerUuid'])
            return {'id': req_id, 'ok': True, 'items': items}

        elif cmd == 'blockhead_inventory_counts':
            items = wm.get_blockhead_inventory_counts(req['playerUuid'], int(req['blockheadId']))
            return {'id': req_id, 'ok': True, 'items': items}

        elif cmd == 'list_blockheads_with_names':
            result = wm.list_blockheads_with_names(req['playerUuid'])
            return {'id': req_id, **result}

        elif cmd == 'get_blockhead_position':
            result = wm.get_blockhead_position(req['playerUuid'], int(req['blockheadId']))
            return {'id': req_id, **result}

        elif cmd == 'find_owner':
            player_uuid = wm.find_owner(int(req['blockheadId']), req.get('candidateUuids', []))
            return {'id': req_id, 'ok': True, 'playerUuid': player_uuid}

        # --- Write ops (WorldManager persistent env) ---

        elif cmd == 'give_item':
            ok = wm.give_item(
                int(req['blockheadId']),
                int(req['itemId']),
                int(req.get('count', 1)),
                req.get('playerUuid'),
                req.get('damage'),
                req.get('color'),
                req.get('level'),
                bool(req.get('basketOnly', False)),
            )
            return {'id': req_id, 'ok': ok}

        elif cmd == 'take_item':
            result = wm.take_item(
                int(req['blockheadId']),
                int(req['itemId']),
                int(req.get('count', 1)),
                req.get('playerUuid'),
            )
            return {'id': req_id, **result}

        elif cmd == 'apply_quest_items':
            result = wm.apply_quest_items(
                int(req['blockheadId']),
                req.get('removeItems', []),
                req.get('giveItems', []),
                req.get('playerUuid'),
            )
            return {'id': req_id, **result}

        elif cmd == 'teleport_blockhead':
            result = wm.teleport_blockhead(
                req['playerUuid'],
                int(req['blockheadId']),
                int(req['x']),
                int(req['y']),
            )
            return {'id': req_id, **result}

        elif cmd == 'find_wild_location':
            save_path = wm._save_path.rstrip('/') + '/'
            result = find_wild_location_fast(
                save_path,
                int(req.get('minY', 521)),
                int(req.get('maxY', 600)),
                int(req.get('spawnX', 78405)),
                int(req.get('minSpawnDistance', 5000)),
            )
            return {'id': req_id, **result}

        else:
            return {'id': req_id, 'ok': False, 'error': f'unknown command: {cmd}'}

    except KeyError as e:
        return {'id': req_id, 'ok': False, 'error': f'missing param: {e}'}
    except Exception as e:
        return {'id': req_id, 'ok': False, 'error': str(e)}


def handle_client(conn: socket.socket, wm: WorldManager) -> None:
    """Handle all requests from a single connected client (the bot)."""
    buf = ''
    MAX_BUF = 1_000_000  # 1MB - prevent unbounded growth from malformed input
    try:
        while True:
            data = conn.recv(65536)
            if not data:
                break
            buf += data.decode('utf-8')
            if len(buf) > MAX_BUF:
                print('[WM Daemon] Buffer exceeded 1MB, dropping connection', file=sys.stderr, flush=True)
                break
            while '\n' in buf:
                line, buf = buf.split('\n', 1)
                line = line.strip()
                if not line:
                    continue
                try:
                    req = json.loads(line)
                    resp = dispatch(wm, req)
                    conn.sendall((json.dumps(resp) + '\n').encode('utf-8'))
                except json.JSONDecodeError as e:
                    conn.sendall((json.dumps({
                        'id': '', 'ok': False, 'error': f'invalid JSON: {e}'
                    }) + '\n').encode('utf-8'))
    except Exception as e:
        print(f'[WM Daemon] Client error: {e}', file=sys.stderr, flush=True)
    finally:
        conn.close()
        print('[WM Daemon] Bot disconnected', flush=True)


def main() -> None:
    if len(sys.argv) < 2:
        print('Usage: uds_daemon.py <save_path>', file=sys.stderr)
        sys.exit(1)

    save_path = sys.argv[1]

    if not os.path.isdir(save_path):
        print(f'[WM Daemon] Save path not found: {save_path}', file=sys.stderr)
        sys.exit(1)

    # Remove stale socket file from a previous run
    if os.path.exists(SOCKET_PATH):
        os.unlink(SOCKET_PATH)

    wm = WorldManager(save_path)
    print(f'[WM Daemon] WorldManager initialized at {save_path}', flush=True)

    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(SOCKET_PATH)
    server.listen(1)
    print(f'[WM Daemon] Listening on {SOCKET_PATH}', flush=True)

    def shutdown(sig, frame):
        print('[WM Daemon] Shutting down...', flush=True)
        try:
            server.close()
        except Exception:
            pass
        wm.close()
        if os.path.exists(SOCKET_PATH):
            os.unlink(SOCKET_PATH)
        sys.exit(0)

    signal.signal(signal.SIGTERM, shutdown)
    signal.signal(signal.SIGINT, shutdown)

    # Accept one connection at a time — the bot is the only client
    while True:
        try:
            conn, _ = server.accept()
            print('[WM Daemon] Bot connected', flush=True)
            handle_client(conn, wm)
        except OSError:
            break


if __name__ == '__main__':
    main()
