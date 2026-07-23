# Blockheads Network Packet Structures

Source: Ghidra RE of `blockheads_server171` (DWARF debug info) + Java proxy packet parsing.

---

## Packet Overview

### Wire Format (all packets)
```
[1 byte: packet ID] [1 byte: keys/flags] [rest: GZIP-compressed plist]
```

The GZIP payload decompresses to a **plist** (binary `bplist00` on Mac, XML on Linux).
The plist contains an **NSArray** of **NSData** blobs. Each NSData blob is one entity's
raw struct bytes (fixed-size, little-endian). Some entity types (Chest, Sign, Bed,
TradePortal) append a variable-length plist tail after the fixed struct.

### Packet IDs

| ID   | Name                      | Direction      | Plist Root | Purpose                    |
|------|---------------------------|----------------|------------|----------------------------|
| 0x07 | DynamicObjectCreate       | Server→Client  | NSArray    | Create entities on client  |
| 0x08 | DynamicObjectUpdate       | Server→Client  | NSArray    | Update entity state        |
| 0x09 | DynamicObjectRemove       | Server→Client  | NSArray    | Delete entities            |
| 0x0A | DynamicObjectCreateClient | Client→Server  | NSArray    | Client creates entity      |
| 0x0B | DynamicObjectUpdateClient | Client→Server  | NSArray    | Client updates entity      |
| 0x0C | DynamicObjectRemoveClient | Client→Server  | NSArray    | Client deletes entity      |

### Related Packets (different format)

| ID   | Name                          | Direction      | Plist Root    | Purpose                     |
|------|-------------------------------|----------------|---------------|-----------------------------|
| 0x06 | BlockheadsData                | Server→Client  | NSDictionary  | Initial blockhead LMDB data |
| 0x20 | UpdatePlayerActionsAndState   | Client→Server  | NSDictionary  | Player state + actions      |
| 0x21 | UpdatePlayerInventory         | Client→Server  | NSDictionary  | Inventory snapshot          |

**0x06 (BlockheadsData)**: `[124 bytes unknown header] [plist NSDictionary]`
Keys: `foundItems_v2` (NSData, gzipped), `foundItems` (NSData), `blockheadFiles` (NSDictionary of NSData, gzipped LMDB blobs keyed by `{playerUUID}_blockhead_{blockheadId}_inventory` etc.)

**0x20 (UpdatePlayerActionsAndState)**: `[GZIP plist NSDictionary]` (no keys byte)
Key `dynamicObjects` → NSArray of NSDictionary per blockhead:
- `uniqueID` (NSNumber) — blockhead unique ID
- `name` (NSString) — blockhead display name
- `owner` (NSString) — player account name
- `pos_x`, `pos_y` (NSNumber) — tile position
- `floatPos` (NSArray of 2 NSNumber) — sub-tile position
- `state` (NSNumber)
- `actions` (NSArray of NSDictionary) — current action with `interactionItemType`, `inventoryChange`
- `selectedToolIndex`, `interactionItemIndex`, `interactionItemSubIndex`
- `skinOptions`, `doubleTimeUnlocked`, `clothingIncrementTimer`

---

## Base Struct: DynamicObjectNetData (24 bytes)

All entity update structs embed this as their first field.

```
Offset  Size  Type      Field
------  ----  --------  -----
0x00     8    uint64    uniqueID
0x08     4    uint32    posX          (tile X)
0x0C     4    uint32    posY          (tile Y)
0x10     1    uint8     needsRemoved  (1 = pending deletion)
0x11     7    uint8[7]  padding
```

Total: **24 bytes**

---

## Entity Update Structs (sent inside 0x07/0x08/0x0A/0x0B/0x0C NSData elements)

### NPCUpdateNetData — 24 bytes (base NPC)

Used by: NPC base class (when subclass doesn't override).

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    DynamicObjectNetData  (base: uniqueID, posX, posY, needsRemoved)
```

Same as DynamicObjectNetData — NPC adds no extra fields at this level.

---

### ScorpionUpdateNetData — 40 bytes

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     4    uint32                toSquareX
0x1C     4    uint32                toSquareY
0x20     2    int16                 walkSpeed        (float * 127.0)
0x22     1    int8                  movementDirection
0x23     1    uint8                 clearQueue
0x24     4    int8[4]               padding
```

---

### CaveTrollUpdateData — 64 bytes

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     4    uint32                fromSquareX
0x1C     4    uint32                fromSquareY
0x20     4    uint32                toSquareX
0x24     4    uint32                toSquareY
0x28     4    uint32                interactingSquareX
0x2C     4    uint32                interactingSquareY
0x30     1    uint8                 traverseType
0x31     1    uint8                 traverseFromKeyFrame
0x32     1    uint8                 traverseToKeyFrame
0x33     1    uint8                 dead
0x34     2    uint16                terrainDifficulty
0x36     1    uint8                 interacting
0x37     1    uint8                 interactionType
0x38     1    uint8                 animationType
0x39     1    uint8                 subAnimationType
0x3A     1    uint8                 health
0x3B     5    uint8[5]              padding
```

---

### DodoUpdateNetData — 40 bytes

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     4    uint32                toSquareX
0x1C     4    uint32                toSquareY
0x20     2    int16                 walkSpeed        (float * 127.0)
0x22     1    int8                  movementDirection
0x23     1    int8                  jumpAndCluck
0x24     3    int8[3]               padding
```

---

### DropBearUpdateNetData — 40 bytes

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     4    uint32                toSquareX
0x1C     4    uint32                toSquareY
0x20     2    int16                 walkSpeed        (float * 127.0)
0x22     1    uint8                 dropping
0x23     1    uint8                 onGround
0x24     4    uint8[4]              padding
```

---

### DonkeyLikeUpdateNetData — 32 bytes

Used by: Donkey (base).

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     2    int16                 targetXSpeed
0x1A     2    int16                 walkSpeed        (float * 127.0)
0x1C     2    int16                 randomGoalRotation
0x1E     1    uint8                 jumpActionSendValue
0x1F     1    uint8                 padding
```

---

### YakUpdateNetData — 40 bytes

```
Offset  Size  Type                       Field
------  ----  -------------------------  -----
0x00    32    DonkeyLikeUpdateNetData    (base — includes NPC base)
0x20     2    int16                      milk
0x22     2    int16                      hair
0x24     4    uint8[4]                   padding
```

---

### SharkUpdateNetData — 40 bytes

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     4    uint32                toSquareX
0x1C     4    uint32                toSquareY
0x20     2    int16                 walkSpeed        (float * 127.0)
0x22     2    uint16                age
0x24     1    int8                  movementDirection
0x25     1    int8                  clearQueue
0x26     2    uint8[2]              padding
```

---

### ClownFishUpdateNetData — 40 bytes

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    NPCUpdateNetData      (base)
0x18     4    uint32                toSquareX
0x1C     4    uint32                toSquareY
0x20     2    int16                 walkSpeed        (float * 127.0)
0x22     1    int8                  movementDirection
0x23     5    int8[5]               padding
```

---

### FreeblockUpdateNetData — 40 bytes (Dropped Items)

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    DynamicObjectNetData  (base)
0x18     8    uint64                priorityBlockheadUniqueID  (who dropped it)
0x20     2    int16                 fallSpeed        (float * 127.0)
0x22     2    int16                 xVelocity        (float * 127.0)
0x24     2    int16                 yVelocity        (float * 127.0)
0x26     1    uint8                 hovers           (1 = floating in place)
0x27     1    uint8                 padding
```

---

### InteractionObjectCreationNetData — 40 bytes

Used by: Workbench, ElevatorMotor, ElevatorShaft, etc. (base class for interactive furniture).

```
Offset  Size  Type                  Field
------  ----  --------------------  -----
0x00    24    DynamicObjectNetData  (base)
0x18     8    uint64                isInUseBlockheadUniqueID  (who is using it)
0x20     2    uint16                interactionObjectType
0x22     1    uint8                 isInUse
0x23     1    uint8                 flipped
0x24     2    uint16                paintColor
0x26     2    uint8[2]              padding
```

---

### BedNetData — 48 bytes

```
Offset  Size  Type                              Field
------  ----  --------------------------------  -----
0x00    40    InteractionObjectCreationNetData  (base — includes DynObj base)
0x28     2    uint16                            itemType
0x2A     2    uint16                            beddingColor
0x2C     4    uint8[4]                          padding
```

Bed also appends a **plist tail** (NSDictionary) with owner info.

---

### BlockheadUpdateData — 112 bytes

The largest fixed struct. Sent for every online blockhead each update tick.

```
Offset  Size  Type                  Field                        Source (Blockhead+offset)
------  ----  --------------------  ---------------------------  ------------------------
0x00    24    DynamicObjectNetData  (base: uniqueID, pos, etc.)
0x18     4    uint32                fromSquareX                  +0x2FC
0x1C     4    uint32                fromSquareY                  +0x300
0x20     4    uint32                toSquareX                    +0x304
0x24     4    uint32                toSquareY                    +0x308
0x28     4    uint32                interactingSquareX           +0x5C (world-wrap adjusted)
0x2C     4    uint32                interactingSquareY           +0x60
0x30     1    uint8                 traverseType                 +0x2E4
0x31     1    uint8                 traverseFromKeyFrame         +0x2E8
0x32     1    uint8                 traverseToKeyFrame           +0x2EC
0x33     1    uint8                 happiness                    +0x74 * 127.0
0x34     2    uint16                interactionItemType          +0xAA8 (held item)
0x36     2    uint16                terrainDifficulty            +0x2F0
0x38     1    uint8                 interacting                  +0x50
0x39     1    uint8                 dead                         (always 0 for update)
0x3A     1    uint8                 paused                       +0x915
0x3B     1    uint8                 interactionType              +0x54
0x3C     1    uint8                 isCurrentlyActive            +0xAAC (or 1 if activeBlockhead)
0x3D     1    uint8                 animationType                +0x9C
0x3E     1    uint8                 subAnimationType             +0xA0
0x3F     1    uint8                 health                       +0x70 * 127.0
0x40     4    int32                 fishingRodCastX              +0x946 (or knock velocity X)
0x44     4    int32                 fishingRodCastY              +0x948 (or knock velocity Y)
0x48     8    uint64                rideObjectID                 +0x390->uniqueID
0x50     8    uint64                interactionObjectID          +0x358->uniqueID
0x58     8    uint64                interactionWorkbenchID       +0x350->uniqueID
0x60     8    uint64                fishingRodFishUniqueID       +0x398->hookedFish->uniqueID
0x68     1    uint8                 heat                         +0x98
0x69     1    uint8                 hasCoffeeEnergy              +0xA4 > 0.0
0x6A     1    uint8                 isOffline                    +0x950
0x6B     1    uint8                 regenerating                 +0xB0
0x6C     1    uint8                 isInJetPackFreeFlightMode    +0x9A8
0x6D     1    uint8                 zIndex                       (isOnFront)
0x6E     1    uint8                 onTradeMission               +0xB8
0x6F     1    uint8                 padding
```

**Note:** When `isInJetPackFreeFlightMode` is set, `fishingRodCastX/Y` are repurposed
as knock velocity (scaled by constant at 0x92F7AC). `health` and `happiness` are
packed as `float * 127.0` → uint8 (range 0-127, divide by 127 to decode).

---

## Variable-Length Entities (fixed struct + plist tail)

Some entity types produce an NSMutableData where they first write the fixed struct,
then append a serialized plist NSDictionary with variable-length fields.

### Chest (0x06AD370)

- Fixed part: 40 bytes (InteractionObjectCreationNetData equivalent)
- Plist tail: NSDictionary containing inventory slots as NSArray of NSArray, plus
  `ownerID`, `ownerName`, level/color data. Very complex — 249 lines of decompiled code.
  Inventory items include type, count, durability, color, enchantments.

### Sign (0x0086ABF0)

- Delegates to parent, adds plist tail with `text` (NSString), `ownerID`, `ownerName`.

### TradePortal (0x007FA6B0)

- Fixed part: InteractionObjectCreationNetData (40 bytes)
- Plist tail: NSDictionary with `localPriceOffsets` (dict of item → price offset),
  `ownerID`, `ownerName`. Our hook zeroes `localPriceOffsets` to freeze prices.

### Bed (0x005A3FD0)

- Fixed part: BedNetData (48 bytes)
- Plist tail: NSDictionary with owner info.

---

## Entities That Delegate to Parent (use parent's struct size)

These call through to their parent class without adding fields:

| Entity      | Delegates To          | Struct Size |
|-------------|-----------------------|-------------|
| Boat        | InteractionObject     | 40 bytes    |
| Column      | InteractionObject     | 40 bytes    |
| Door        | InteractionObject     | 40 bytes    |
| Torch       | InteractionObject     | 40 bytes    |
| Plant       | InteractionObject     | 40 bytes    |
| Stairs      | InteractionObject     | 40 bytes    |
| Window      | InteractionObject     | 40 bytes    |
| Ladder      | InteractionObject     | 40 bytes    |
| Painting    | InteractionObject     | 40 bytes    |
| Mirror      | InteractionObject     | 40 bytes    |

---

## Struct Inheritance Hierarchy

```
DynamicObjectNetData (24 bytes)
├── NPCUpdateNetData (24 bytes)
│   ├── ScorpionUpdateNetData (40 bytes)
│   ├── CaveTrollUpdateData (64 bytes)
│   ├── DodoUpdateNetData (40 bytes)
│   ├── DropBearUpdateNetData (40 bytes)
│   ├── ClownFishUpdateNetData (40 bytes)
│   ├── SharkUpdateNetData (40 bytes)
│   └── DonkeyLikeUpdateNetData (32 bytes)
│       └── YakUpdateNetData (40 bytes)
├── FreeblockUpdateNetData (40 bytes)
├── InteractionObjectCreationNetData (40 bytes)
│   ├── BedNetData (48 bytes) + plist tail
│   ├── Chest + plist tail (inventory)
│   ├── Sign + plist tail (text, owner)
│   ├── TradePortal + plist tail (prices, owner)
│   ├── Workbench (40 bytes)
│   ├── ElevatorMotor (40 bytes)
│   ├── ElevatorShaft (40 bytes)
│   └── [Boat, Column, Door, Torch, Plant, Stairs, etc.] (40 bytes)
└── BlockheadUpdateData (112 bytes)
```

---

## Encoding Notes

- **Float packing**: Speed/health/happiness fields are packed as `(float * 127.0)` → int16/uint8.
  Decode: divide by 127.0 to get 0.0–1.0 range.
- **Velocity packing**: Uses constant at `0x00919BE0` (127.0) for scaling.
- **Position**: `posX`/`posY` are tile coordinates (int32 little-endian). Sub-tile precision
  is only available in the 0x20 packet (`floatPos` array).
- **World-wrap**: `interactingSquareX` for Blockheads is world-wrap adjusted:
  `if (val < 0) val += worldWidthMacro * 32`
- **uniqueID**: uint64 at DynamicObject+0x40 in memory. Same value in packets.
- **needsRemoved**: uint8 flag. When set, client should delete the entity.

---

## Method Addresses (updateNetDataForClient:)

| Class             | Address    | Struct Size |
|-------------------|------------|-------------|
| DynamicObject     | 0x007075B0 | returns nil |
| NPC               | 0x007B7030 | 24 bytes    |
| Scorpion          | 0x00790E80 | 40 bytes    |
| CaveTroll         | 0x0086ECF0 | 64 bytes    |
| Dodo              | 0x006D9850 | 40 bytes    |
| DropBear          | 0x006F7230 | 40 bytes    |
| DonkeyLike        | 0x00688030 | 32 bytes    |
| Yak               | 0x00897270 | 40 bytes    |
| Shark             | 0x007D9BB0 | 40 bytes    |
| ClownFish         | 0x006BA570 | 40 bytes    |
| FreeBlock         | 0x00781280 | 40 bytes    |
| Blockhead         | 0x005BFCE0 | 112 bytes   |
| InteractionObject | 0x0078E2D0 | 40 bytes    |
| Bed               | 0x005A3FD0 | 48+plist    |
| Chest             | 0x006AD370 | 40+plist    |
| Sign              | 0x0086ABF0 | 40+plist    |
| TradePortal       | 0x007FA6B0 | 40+plist    |
| Workbench         | 0x0084C190 | 40 bytes    |
| ElevatorMotor     | 0x0076F1A0 | 40 bytes    |
| ElevatorShaft     | 0x00771730 | 40 bytes    |
| Door              | 0x006F1680 | 40 bytes    |
| Plant             | 0x007D6820 | 40 bytes    |
| Rail              | 0x0088FE00 | 40 bytes    |
| TrainCar          | 0x00805240 | 40 bytes    |
| TrainStation      | 0x008A45C0 | 40 bytes    |
| FreightCar        | 0x0080B1B0 | 40 bytes    |
| PassengerCar      | 0x0082EDA0 | 40 bytes    |
| FireObject        | 0x007757B0 | 40 bytes    |
| Column            | 0x006CC0A0 | 40 bytes    |
| Torch             | 0x007F3400 | 40 bytes    |
| Stairs            | 0x007EBB30 | 40 bytes    |
| Window            | 0x008433B0 | 40 bytes    |
| Wire              | 0x0089C980 | 40 bytes    |
| Painting          | 0x007C4E80 | 40 bytes    |
| Ladder            | 0x007A49F0 | 40 bytes    |
| Mirror            | 0x00893D50 | 40 bytes    |
| Egg               | 0x0076D2B0 | 40 bytes    |
| Boat              | 0x0067B420 | 40 bytes    |
| TradingPost       | 0x0066F8C0 | 40 bytes    |
