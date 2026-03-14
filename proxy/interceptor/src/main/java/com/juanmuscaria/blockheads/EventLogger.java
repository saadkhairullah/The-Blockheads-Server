package com.juanmuscaria.blockheads;

import com.juanmuscaria.blockheads.network.ItemDecoder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.time.Instant;
import java.util.*;
import java.util.concurrent.*;

/**
 * Logs important game events and broadcasts them via Unix Domain Socket for bot consumption.
 * Events are serialized as JSON lines (one JSON object per line).
 */
public class EventLogger {
    private static final Logger logger = LoggerFactory.getLogger(EventLogger.class);
    private static EventLogger instance;

    private final BlockingQueue<String> eventQueue = new LinkedBlockingQueue<>(10000);
    private final Thread writerThread;
    private volatile boolean running = true;

    // UDS broadcast (set by BHInterceptor after UDS server starts)
    private static volatile UDSEventServer udsServer;

    public static void setUDSServer(UDSEventServer server) {
        udsServer = server;
    }

    // Track player positions
    private final Map<Integer, int[]> playerPositions = new ConcurrentHashMap<>();
    private static final int MAX_POSITION_TRACK = 500;

    // Only emit ITEM_PICKUP/DROP events for these forbidden items (reduces event volume)
    private static final Set<Integer> FORBIDDEN_ITEM_IDS = Set.of(
        1074,  // PORTAL_CHEST
        206,   // FREIGHT_CAR
        300    // ELECTRIC_SLUICE
    );

    private EventLogger() {
        this.writerThread = new Thread(this::writeEvents, "EventLogger-Writer");
        this.writerThread.setDaemon(true);
        this.writerThread.start();

        logger.info("EventLogger initialized (UDS broadcast mode)");
    }

    public static synchronized EventLogger getInstance() {
        if (instance == null) {
            instance = new EventLogger();
        }
        return instance;
    }

    private void writeEvents() {
        try {
            while (running || !eventQueue.isEmpty()) {
                String event = eventQueue.poll(100, TimeUnit.MILLISECONDS);
                if (event != null && udsServer != null) {
                    try {
                        udsServer.broadcast(event);
                    } catch (Exception e) {
                        logger.warn("Failed to broadcast event via UDS: {}", e.getMessage());
                    }
                }
            }
        } catch (Exception e) {
            logger.error("Error in event broadcast loop", e);
        }
    }

    public void shutdown() {
        running = false;
        try {
            writerThread.join(5000);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
    }

    /**
     * Log a player picking up an item.
     * Only raw identifiers are logged - no name mapping is done here.
     * The bot should use blockheadId or playerUUID to look up player info from LMDB.
     *
     * @param blockheadId The blockhead's unique ID (use for LMDB lookup)
     * @param playerUUID The player's UUID from BlockheadsData (use for LMDB lookup, may be null)
     */
    public void logItemPickup(int blockheadId, int x, int y, String itemName, int itemId, int count, String source, String playerUUID) {
        // Only emit events for forbidden items to reduce event volume
        if (!FORBIDDEN_ITEM_IDS.contains(itemId)) {
            return;
        }

        boolean isIllegal = ItemDecoder.isIllegalItem(itemId);

        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"ITEM_PICKUP\",\"time\":\"").append(Instant.now().toString()).append("\"");
        json.append(",\"blockheadId\":").append(blockheadId);
        if (playerUUID != null && !playerUUID.isEmpty()) {
            json.append(",\"playerUUID\":\"").append(escapeJson(playerUUID)).append("\"");
        }
        json.append(",\"x\":").append(x).append(",\"y\":").append(y);
        json.append(",\"item\":\"").append(escapeJson(itemName)).append("\"");
        json.append(",\"itemId\":").append(itemId);
        json.append(",\"count\":").append(count);
        json.append(",\"illegal\":").append(isIllegal);
        if (source != null && !source.isEmpty()) {
            json.append(",\"source\":\"").append(escapeJson(source)).append("\"");
        }
        json.append("}");

        eventQueue.offer(json.toString());

        logger.warn("FORBIDDEN ITEM DETECTED: blockheadId={} playerUUID={} picked up {} (id={}) x{} at ({},{})",
            blockheadId, playerUUID, itemName, itemId, count, x, y);
    }

    /**
     * Log a player dropping an item.
     * Only raw identifiers are logged - no name mapping is done here.
     * The bot should use blockheadId or playerUUID to look up player info from LMDB.
     *
     * @param blockheadId The blockhead's unique ID (use for LMDB lookup)
     * @param playerUUID The player's UUID from BlockheadsData (use for LMDB lookup, may be null)
     */
    public void logItemDrop(int blockheadId, int x, int y, String itemName, int itemId, int count, String source, String playerUUID) {
        // Only emit events for forbidden items to reduce event volume
        if (!FORBIDDEN_ITEM_IDS.contains(itemId)) {
            return;
        }

        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"ITEM_DROP\",\"time\":\"").append(Instant.now().toString()).append("\"");
        json.append(",\"blockheadId\":").append(blockheadId);
        if (playerUUID != null && !playerUUID.isEmpty()) {
            json.append(",\"playerUUID\":\"").append(escapeJson(playerUUID)).append("\"");
        }
        json.append(",\"x\":").append(x).append(",\"y\":").append(y);
        json.append(",\"item\":\"").append(escapeJson(itemName)).append("\"");
        json.append(",\"itemId\":").append(itemId);
        json.append(",\"count\":").append(count);
        if (source != null && !source.isEmpty()) {
            json.append(",\"source\":\"").append(escapeJson(source)).append("\"");
        }
        json.append("}");

        eventQueue.offer(json.toString());

        logger.info("FORBIDDEN ITEM DROP: blockheadId={} playerUUID={} dropped {} (id={}) x{} at ({},{})",
            blockheadId, playerUUID, itemName, itemId, count, x, y);
    }

    /**
     * Log player position update.
     * Only raw blockheadId is logged - the bot should use LMDB to look up player info.
     */
    public void logPlayerPosition(int blockheadId, int x, int y) {
        int[] oldPos = playerPositions.put(blockheadId, new int[]{x, y});

        // Only log if position changed significantly (more than 10 units)
        if (oldPos == null || Math.abs(oldPos[0] - x) > 10 || Math.abs(oldPos[1] - y) > 10) {
            String json = String.format(
                "{\"type\":\"PLAYER_MOVE\",\"time\":\"%s\",\"blockheadId\":%d,\"x\":%d,\"y\":%d}",
                Instant.now().toString(),
                blockheadId,
                x, y
            );

            eventQueue.offer(json);
        }
        // Prevent unbounded growth if many unique blockheads appear
        if (playerPositions.size() > MAX_POSITION_TRACK) {
            playerPositions.clear();
        }
    }

    /**
     * Log an inventory snapshot for a blockhead.
     * Only raw identifiers are logged - the bot should use LMDB to look up player info.
     *
     * @param blockheadId The blockhead's unique ID (use for LMDB lookup)
     * @param playerUUID The player's UUID from BlockheadsData (use for LMDB lookup, may be null)
     */
    public void logInventorySnapshot(int blockheadId, Map<Integer, Integer> items, String source, String playerUUID) {
        // Only emit snapshot if inventory contains forbidden items (reduces event volume)
        boolean hasForbidden = false;
        for (int id : items.keySet()) {
            if (FORBIDDEN_ITEM_IDS.contains(id)) {
                hasForbidden = true;
                break;
            }
        }
        if (!hasForbidden) {
            return;
        }

        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"INVENTORY_SNAPSHOT\",\"time\":\"").append(Instant.now().toString()).append("\"");
        json.append(",\"blockheadId\":").append(blockheadId);
        if (playerUUID != null && !playerUUID.isEmpty()) {
            json.append(",\"playerUUID\":\"").append(escapeJson(playerUUID)).append("\"");
        }
        if (source != null && !source.isEmpty()) {
            json.append(",\"source\":\"").append(escapeJson(source)).append("\"");
        }
        // Only include forbidden items in the snapshot
        json.append(",\"items\":[");

        List<Integer> ids = new ArrayList<>(items.keySet());
        Collections.sort(ids);
        boolean first = true;
        for (int id : ids) {
            if (!FORBIDDEN_ITEM_IDS.contains(id)) {
                continue;  // Skip non-forbidden items
            }
            int count = items.get(id);
            String itemName = ItemDecoder.getItemName(id);
            if (!first) {
                json.append(",");
            }
            first = false;
            json.append("{\"item\":\"").append(escapeJson(itemName)).append("\"");
            json.append(",\"itemId\":").append(id);
            json.append(",\"count\":").append(count).append("}");
        }
        json.append("]}");

        eventQueue.offer(json.toString());

        logger.info("FORBIDDEN INVENTORY: blockheadId={} playerUUID={} has forbidden items",
            blockheadId, playerUUID);
    }

    /**
     * Log full player state (for debugging).
     * Only raw blockheadId is logged - the bot should use LMDB to look up player info.
     */
    public void logPlayerState(int blockheadId, int x, int y, String action, String inventoryChange) {
        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"PLAYER_STATE\",\"time\":\"").append(Instant.now().toString()).append("\"");
        json.append(",\"blockheadId\":").append(blockheadId);
        json.append(",\"x\":").append(x).append(",\"y\":").append(y);
        if (action != null) {
            json.append(",\"action\":\"").append(escapeJson(action)).append("\"");
        }
        if (inventoryChange != null) {
            json.append(",\"invChange\":\"").append(escapeJson(inventoryChange)).append("\"");
        }
        json.append("}");

        eventQueue.offer(json.toString());
    }

    /**
     * Log player using an item/block.
     * Only raw blockheadId is logged - the bot should use LMDB to look up player info.
     */
    public void logPlayerAction(int blockheadId, int x, int y, String action, String inventoryChange) {
        StringBuilder json = new StringBuilder();
        json.append("{\"type\":\"PLAYER_ACTION\",\"time\":\"").append(Instant.now().toString()).append("\"");
        json.append(",\"blockheadId\":").append(blockheadId);
        json.append(",\"x\":").append(x).append(",\"y\":").append(y);
        json.append(",\"action\":\"").append(escapeJson(action)).append("\"");
        if (inventoryChange != null && !inventoryChange.isEmpty()) {
            json.append(",\"inventoryChange\":\"").append(escapeJson(inventoryChange)).append("\"");
        }
        json.append("}");

        eventQueue.offer(json.toString());
    }

    /**
     * Log a player command (e.g. /quest, /balance) and broadcast via UDS to the bot.
     */
    public void logCommand(String playerName, String command) {
        String json = String.format(
            "{\"type\":\"command\",\"player\":\"%s\",\"command\":\"%s\",\"time\":%d}",
            escapeJson(playerName), escapeJson(command), System.currentTimeMillis()
        );
        eventQueue.offer(json);
    }

    /**
     * Get current position of a player (for /coords command).
     */
    public int[] getPlayerPosition(int blockheadId) {
        return playerPositions.get(blockheadId);
    }

    /**
     * Get all tracked player positions.
     */
    public Map<Integer, int[]> getAllPlayerPositions() {
        return new HashMap<>(playerPositions);
    }

    /**
     * Fix 4: Remove position data for a blockhead (call on disconnect).
     */
    public void removeBlockheadPosition(int blockheadId) {
        playerPositions.remove(blockheadId);
    }

    /**
     * Get the number of tracked positions (for monitoring).
     */
    public int getTrackedPositionCount() {
        return playerPositions.size();
    }

    private String escapeJson(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\n", "\\n")
                .replace("\r", "\\r")
                .replace("\t", "\\t");
    }
}
