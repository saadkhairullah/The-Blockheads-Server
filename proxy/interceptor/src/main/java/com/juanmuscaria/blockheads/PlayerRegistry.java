package com.juanmuscaria.blockheads;

import com.dd.plist.NSArray;
import com.dd.plist.NSData;
import com.dd.plist.NSNumber;
import com.dd.plist.NSObject;
import com.juanmuscaria.blockheads.network.ItemDecoder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentSkipListSet;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Tracks inventory states for detecting changes and maps IDs for cleanup.
 *
 * Note: Name tracking is minimal - only used for cleanup on disconnect.
 * Console-Loader handles all player name resolution via daemon/LMDB.
 */
public class PlayerRegistry {
    private static final Logger logger = LoggerFactory.getLogger(PlayerRegistry.class);
    private static PlayerRegistry instance;

    // Pattern to detect player leaving (for cleanup)
    private static final Pattern LEFT_PATTERN = Pattern.compile("([^ ]+) has left the server!");

    // Map blockheadId -> player account name (only for cleanup on disconnect)
    private final Map<Integer, String> playerNames = new ConcurrentHashMap<>();

    // Map blockheadId -> last known inventory (itemId -> count)
    private final Map<Integer, Map<Integer, Integer>> inventorySnapshots = new ConcurrentHashMap<>();

    // Map blockheadId (full unique ID) -> player UUID (from BlockheadsData keys)
    private final Map<Integer, String> blockheadToPlayerUUID = new ConcurrentHashMap<>();
    // Map playerUUID -> set of blockhead IDs owned by this player
    private final Map<String, Set<Integer>> playerUUIDToBlockheads = new ConcurrentHashMap<>();

    private PlayerRegistry() {}

    public static synchronized PlayerRegistry getInstance() {
        if (instance == null) {
            instance = new PlayerRegistry();
        }
        return instance;
    }

    /**
     * Process a chat message to detect player leaving for cleanup.
     * Returns the player name if they left, null otherwise.
     */
    public String processChatMessage(String alias, String message) {
        if ("SERVER".equals(alias)) {
            Matcher leftMatcher = LEFT_PATTERN.matcher(message);
            if (leftMatcher.find()) {
                String leftName = leftMatcher.group(1);
                logger.info("Detected player left: {}", leftName);
                return leftName;
            }
        }
        return null;
    }

    /**
     * Register a blockhead's player name (only for cleanup purposes).
     * Name resolution for logging is handled by Console-Loader via daemon.
     */
    public void registerBlockhead(int uniqueId, String playerName) {
        // Only track playerName for cleanup on disconnect
        if (playerName != null && !playerName.equals("?")) {
            playerNames.put(uniqueId, playerName);
        }
    }

    /**
     * Register a blockhead's association with a player UUID.
     * This is extracted from BlockheadsData keys like "{playerUUID}_blockhead_{blockheadId}_inventory"
     */
    public void registerBlockheadPlayerUUID(int blockheadId, String playerUUID) {
        if (playerUUID == null || playerUUID.isEmpty()) return;
        blockheadToPlayerUUID.put(blockheadId, playerUUID);
        playerUUIDToBlockheads.computeIfAbsent(playerUUID, k -> new ConcurrentSkipListSet<>()).add(blockheadId);
        logger.debug("Registered blockhead {} -> playerUUID {}", blockheadId, playerUUID);
    }

    /**
     * Get the player UUID for a blockhead ID.
     * Returns null if not known.
     */
    public String getPlayerUUIDForBlockhead(int blockheadId) {
        return blockheadToPlayerUUID.get(blockheadId);
    }

    /**
     * Parse inventory data and return item counts (itemId -> count).
     *
     * Inventory structure (reverse-engineered):
     * - NSNumber(0) = empty/unchanged slot
     * - NSDictionary with numeric keys:
     *   - Key "1" or "2" = single items (tools, weapons) as NSArray of NSData[8]
     *   - Key "3" = container contents (basket slots) as NSArray of NSData[8]
     * - NSData[8] = item data: bytes 0-1 = itemId, bytes 2-3 = count (little-endian)
     */
    public Map<Integer, Integer> parseInventory(NSArray inventoryData) {
        Map<Integer, Integer> items = new HashMap<>();
        if (inventoryData == null) return items;

        for (int slot = 0; slot < inventoryData.count(); slot++) {
            NSObject obj = inventoryData.objectAtIndex(slot);

            if (obj instanceof NSNumber) {
                // Empty or unchanged slot - skip
                continue;
            } else if (obj instanceof com.dd.plist.NSDictionary) {
                // Slot contains items - keys are numeric indices
                com.dd.plist.NSDictionary dict = (com.dd.plist.NSDictionary) obj;
                for (String key : dict.allKeys()) {
                    NSObject value = dict.get(key);
                    if (value instanceof NSArray) {
                        extractItemsFromArray((NSArray) value, items);
                    } else if (value instanceof NSData) {
                        extractItemFromData((NSData) value, items);
                    }
                }
            } else if (obj instanceof NSArray) {
                // Direct array of items (legacy format?)
                extractItemsFromArray((NSArray) obj, items);
            }
        }
        return items;
    }

    /**
     * Extract items from an NSArray (which contains NSData items).
     */
    private void extractItemsFromArray(NSArray array, Map<Integer, Integer> items) {
        for (int i = 0; i < array.count(); i++) {
            NSObject itemObj = array.objectAtIndex(i);
            if (itemObj instanceof NSData) {
                extractItemFromData((NSData) itemObj, items, array.count());
            } else if (itemObj instanceof NSArray) {
                // Nested array - recurse
                extractItemsFromArray((NSArray) itemObj, items);
            }
        }
    }

    /**
     * Extract a single item from NSData and add to items map.
     */
    private void extractItemFromData(NSData data, Map<Integer, Integer> items) {
        extractItemFromData(data, items, 1);
    }

    /**
     * Extract a single item from NSData and add to items map.
     * Array size is used to decide when to ignore per-item metadata as count.
     */
    private void extractItemFromData(NSData data, Map<Integer, Integer> items, int arraySize) {
        byte[] bytes = data.bytes();
        if (bytes.length >= 4) {
            int[] decoded = ItemDecoder.decodeItemIdCountAndExtra(bytes);
            if (decoded != null && decoded[0] != 0) {
                int itemId = decoded[0];
                int count = decoded[1];
                int extra = decoded[2];
                if (arraySize > 1) {
                    count = 1;
                } else if (count == 0) {
                    count = 1; // Some items have count=0 but mean 1
                } else if (extra == 0 && count > 1) {
                    // Likely per-item metadata encoded in the count field (durability/freshness).
                    count = 1;
                }
                items.merge(itemId, count, Integer::sum);
            }
        }
    }

    /**
     * Update inventory and return changes (positive = pickup, negative = drop).
     */
    public List<InventoryChange> updateInventory(int blockheadId, NSArray newInventoryData) {
        List<InventoryChange> changes = new ArrayList<>();

        Map<Integer, Integer> newInventory = parseInventory(newInventoryData);
        Map<Integer, Integer> oldInventory = inventorySnapshots.get(blockheadId);

        if (oldInventory != null) {
            // Find items that increased (pickups)
            for (Map.Entry<Integer, Integer> entry : newInventory.entrySet()) {
                int itemId = entry.getKey();
                int newCount = entry.getValue();
                int oldCount = oldInventory.getOrDefault(itemId, 0);
                if (newCount > oldCount) {
                    changes.add(new InventoryChange(itemId, newCount - oldCount));
                }
            }

            // Find items that decreased (drops)
            for (Map.Entry<Integer, Integer> entry : oldInventory.entrySet()) {
                int itemId = entry.getKey();
                int oldCount = entry.getValue();
                int newCount = newInventory.getOrDefault(itemId, 0);
                if (newCount < oldCount) {
                    changes.add(new InventoryChange(itemId, newCount - oldCount));
                }
            }
        }

        // Store new snapshot
        inventorySnapshots.put(blockheadId, newInventory);

        return changes;
    }

    /**
     * Clear all data (call on full server reset).
     */
    public void clear() {
        playerNames.clear();
        inventorySnapshots.clear();
        blockheadToPlayerUUID.clear();
        playerUUIDToBlockheads.clear();
    }

    /**
     * Remove a specific blockhead's data (call on player disconnect).
     * This prevents memory from growing unbounded over time.
     */
    public void removeBlockhead(int blockheadId) {
        playerNames.remove(blockheadId);
        inventorySnapshots.remove(blockheadId);

        // Clean up playerUUID mappings
        String playerUUID = blockheadToPlayerUUID.remove(blockheadId);
        if (playerUUID != null) {
            var blockheads = playerUUIDToBlockheads.get(playerUUID);
            if (blockheads != null) {
                blockheads.remove(blockheadId);
                if (blockheads.isEmpty()) {
                    playerUUIDToBlockheads.remove(playerUUID);
                }
            }
        }
        logger.debug("Cleaned up data for blockhead {}", blockheadId);
    }

    /**
     * Remove all blockheads associated with a player name.
     */
    public void removePlayerByName(String playerName) {
        if (playerName == null) return;

        // Find all blockhead IDs associated with this player
        var toRemove = new ArrayList<Integer>();
        for (var entry : playerNames.entrySet()) {
            if (playerName.equals(entry.getValue())) {
                toRemove.add(entry.getKey());
            }
        }

        // Remove all found blockheads
        for (int blockheadId : toRemove) {
            removeBlockhead(blockheadId);
        }

        if (!toRemove.isEmpty()) {
            logger.info("Cleaned up {} blockhead(s) for player {}", toRemove.size(), playerName);
        }

        // Clean up inventory ID mappings for this player
        // (inventoryIdToUniqueId entries will be overwritten on next login anyway)
    }

    /**
     * Get the number of tracked blockheads (for monitoring).
     */
    public int getTrackedBlockheadCount() {
        return inventorySnapshots.size();
    }

    public record InventoryChange(int itemId, int delta) {
        public String getItemName() {
            return ItemDecoder.getItemName(itemId);
        }

        public boolean isPickup() {
            return delta > 0;
        }
    }
}
