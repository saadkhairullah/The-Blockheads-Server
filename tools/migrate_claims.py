#!/usr/bin/env python3
"""
One-time migration: convert ~/blockheads_claims_cache.json (raw sign positions)
into data/claims.json (ClaimRecord format with radius/owner).

Existing signs get radius=0 and owner="existing" since we only need their
centers for the 122-block minimum-distance check.
"""
import json
import os
import sys

SRC = os.path.expanduser('~/blockheads_claims_cache.json')
DST = os.path.join(os.path.dirname(__file__), '..', 'data', 'claims.json')

with open(SRC) as f:
    positions = json.load(f)

records = [{'x': p['x'], 'y': p['y'], 'radius': 0, 'owner': 'existing'} for p in positions]

# Merge with any new claims already in claims.json
existing = []
if os.path.exists(DST):
    with open(DST) as f:
        existing = json.load(f)
    new_coords = {(r['x'], r['y']) for r in existing if r.get('owner') != 'existing'}
    records = [r for r in records if (r['x'], r['y']) not in new_coords]
    merged = records + [r for r in existing if r.get('owner') != 'existing']
else:
    merged = records

with open(DST, 'w') as f:
    json.dump(merged, f, indent=2)

print(f'Wrote {len(merged)} records to {DST} ({len(records)} from cache, {len(existing) - len([r for r in existing if r.get("owner") == "existing"])} new)')
