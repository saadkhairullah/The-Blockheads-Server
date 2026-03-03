package com.juanmuscaria.blockheads;

import com.juanmuscaria.blockheads.chat.ChatMessage;
import com.juanmuscaria.blockheads.network.packets.client.UpdatePlayerActionsAndState;
import com.juanmuscaria.blockheads.network.packets.client.UpdatePlayerInventory;
import com.juanmuscaria.blockheads.network.packets.server.BlockheadsData;
import com.juanmuscaria.blockheads.network.packets.server.ChatHistory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Static handlers that delegate packet data to EventLogger and PlayerRegistry.
 */
public final class PacketEventHandler {
  private static final Logger logger = LoggerFactory.getLogger(PacketEventHandler.class);

  private PacketEventHandler() {}

  static void logPlayerEvents(UpdatePlayerActionsAndState playerState) {
    try {
      EventLogger eventLogger = EventLogger.getInstance();
      PlayerRegistry registry = PlayerRegistry.getInstance();

      for (UpdatePlayerActionsAndState.PlayerInfo player : playerState.getPlayers()) {
        // Register blockhead for cleanup on disconnect only
        registry.registerBlockhead(player.uniqueId, player.playerName);

        // Look up playerUUID for this blockhead (from BlockheadsData)
        String playerUUID = registry.getPlayerUUIDForBlockhead(player.uniqueId);

        // Log position - only blockheadId, no names (bot uses LMDB for lookup)
        eventLogger.logPlayerPosition(player.uniqueId, player.x, player.y);

        // Log when player uses/interacts with an item
        if (player.action != null) {
          eventLogger.logPlayerAction(player.uniqueId, player.x, player.y, player.action, player.inventoryChange);
        }

        // Log inventory changes (actual pickups/drops from container interactions)
        for (UpdatePlayerActionsAndState.InventoryDelta delta : player.inventoryDeltas) {
          if (delta.delta > 0) {
            eventLogger.logItemPickup(player.uniqueId, player.x, player.y, delta.itemName, delta.itemId, delta.delta, "player_state", playerUUID);
          } else if (delta.delta < 0) {
            eventLogger.logItemDrop(player.uniqueId, player.x, player.y, delta.itemName, delta.itemId, -delta.delta, "player_state", playerUUID);
          }
        }
      }
    } catch (Exception e) {
      // Ignore logging errors
    }
  }

  /**
   * Process ChatHistory packets to extract player account names from welcome messages.
   * Also detects player disconnect and cleans up their data.
   */
  static void processChatHistory(ChatHistory chatHistory) {
    try {
      PlayerRegistry registry = PlayerRegistry.getInstance();
      EventLogger eventLogger = EventLogger.getInstance();

      for (ChatMessage message : chatHistory.getMessages()) {
        String leftPlayer = registry.processChatMessage(message.getAlias(), message.getMessage());

        // Clean up player data when they leave
        if (leftPlayer != null) {
          registry.removePlayerByName(leftPlayer);
          logger.info("Cleaned up registry data for disconnected player: {} (tracked: {} blockheads, {} positions)",
                  leftPlayer, registry.getTrackedBlockheadCount(), eventLogger.getTrackedPositionCount());
        }
      }
    } catch (Exception e) {
      // Ignore processing errors
    }
  }

  /**
   * Process UpdatePlayerInventory packets to detect ground pickups/drops.
   * Inventory update packets use a short inventory id plus header bytes; derive unique ID when available.
   * No name mapping is done here - only raw IDs are logged for bot to look up via LMDB.
   */
  static void processInventoryUpdate(UpdatePlayerInventory inventoryUpdate) {
    try {
      PlayerRegistry registry = PlayerRegistry.getInstance();
      EventLogger eventLogger = EventLogger.getInstance();

      Integer derivedUniqueId = inventoryUpdate.getDerivedUniqueId();
      int blockheadId = derivedUniqueId != null ? derivedUniqueId : inventoryUpdate.getBlockheadId();
      var inventoryData = inventoryUpdate.getData();

      // Look up the playerUUID for this blockhead (registered from BlockheadsData)
      String playerUUID = registry.getPlayerUUIDForBlockhead(blockheadId);

      if (inventoryData == null) {
        return;
      }

      // Parse and show the items we extracted
      var parsedItems = registry.parseInventory(inventoryData);
      if (!parsedItems.isEmpty()) {
        // Log snapshot with only raw IDs - bot uses LMDB for player lookup
        eventLogger.logInventorySnapshot(blockheadId, parsedItems, "inventory_update", playerUUID);
      }

      // Get inventory changes by comparing with previous snapshot
      var changes = registry.updateInventory(blockheadId, inventoryData);

      if (changes.isEmpty()) {
        logger.debug("INV_DEBUG: blockheadId={} - no changes detected (baseline or same)", blockheadId);
      } else {
        for (var change : changes) {
          if (change.isPickup()) {
            // Log with only raw IDs - bot uses LMDB for player lookup
            eventLogger.logItemPickup(blockheadId, 0, 0, change.getItemName(), change.itemId(), change.delta(), "inventory_update", playerUUID);
          } else {
            eventLogger.logItemDrop(blockheadId, 0, 0, change.getItemName(), change.itemId(), -change.delta(), "inventory_update", playerUUID);
          }
        }
      }
    } catch (Exception e) {
      logger.warn("INV_DEBUG: Error processing inventory update: {}", e.getMessage());
    }
  }

  static void logBlockheadsData(BlockheadsData blockheadsData) {
    var files = blockheadsData.getBlockheadFiles();
    if (files.isEmpty()) {
      return;
    }
    logger.info("BLOCKHEAD_FILES: {} entries", files.size());
    PlayerRegistry registry = PlayerRegistry.getInstance();

    for (var entry : files.entrySet()) {
      String key = entry.getKey();
      byte[] gzBytes = entry.getValue();
      logger.info("  blockheadFile key={} size={}", key, gzBytes.length);

      // Extract playerUUID and blockheadId from keys like:
      // "{playerUUID}_blockhead_{blockheadId}_inventory" or "{playerUUID}_blockheads"
      extractAndRegisterPlayerUUID(key, registry);
    }
  }

  /**
   * Extract playerUUID and blockheadId from BlockheadsData keys and register the mapping.
   * Key formats:
   * - "{playerUUID}_blockhead_{blockheadId}_inventory" -> extracts both UUID and blockheadId
   * - "{playerUUID}_blockheads" -> extracts UUID only (blockheads list, not inventory)
   */
  private static void extractAndRegisterPlayerUUID(String key, PlayerRegistry registry) {
    // Pattern: {uuid}_blockhead_{id}_inventory
    if (key.contains("_blockhead_") && key.endsWith("_inventory")) {
      int underscoreIdx = key.indexOf("_blockhead_");
      if (underscoreIdx > 0) {
        String playerUUID = key.substring(0, underscoreIdx);
        String remainder = key.substring(underscoreIdx + "_blockhead_".length());
        int invIdx = remainder.indexOf("_inventory");
        if (invIdx > 0) {
          try {
            int blockheadId = Integer.parseInt(remainder.substring(0, invIdx));
            registry.registerBlockheadPlayerUUID(blockheadId, playerUUID);
            logger.info("  Registered blockheadId={} -> playerUUID={}", blockheadId, playerUUID);
          } catch (NumberFormatException e) {
            // Ignore malformed keys
          }
        }
      }
    }
  }
}
