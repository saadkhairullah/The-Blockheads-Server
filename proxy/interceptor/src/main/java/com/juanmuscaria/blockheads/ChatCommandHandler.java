package com.juanmuscaria.blockheads;

import com.juanmuscaria.blockheads.network.BHHelper;
import com.juanmuscaria.blockheads.network.packets.Packet;
import com.juanmuscaria.blockheads.network.packets.server.ChatHistory;
import com.juanmuscaria.foreign.enet.ENet;
import com.juanmuscaria.foreign.enet.ENetPacket;
import com.dd.plist.NSArray;
import com.dd.plist.NSDate;
import com.dd.plist.NSDictionary;
import com.dd.plist.NSString;
import com.dd.plist.XMLPropertyListWriter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayOutputStream;
import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.text.Normalizer;
import java.util.Date;
import java.util.HexFormat;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Handles player name mapping, command interception, chat channel capture,
 * and private message delivery.
 */
public class ChatCommandHandler {
  private static final Logger logger = LoggerFactory.getLogger(ChatCommandHandler.class);
  private static final Path COMMAND_EVENT_FILE = Path.of(System.getProperty("bh.commandEventsFile", "command_events.jsonl"));

  // Player name -> client peer address mapping (for private messages)
  private final Map<String, Long> playerNameToClientId = new ConcurrentHashMap<>();
  private final Map<String, Long> playerNameToClientIdLower = new ConcurrentHashMap<>();
  private final Map<String, Long> playerNameToClientIdNormalized = new ConcurrentHashMap<>();
  private final Map<Long, String> clientIdToPlayerName = new ConcurrentHashMap<>();

  // Channel ID used by ChatHistory packets (captured from first server ChatHistory)
  private volatile int chatHistoryChannel = -1;
  private volatile byte chatPacketId = ChatHistory.ID;
  private volatile boolean chatPacketUsesMessagesArray = true;

  public record ResolvedTarget(long clientId, String matchType) {}

  /**
   * Remove player mapping when a client disconnects.
   * @return the disconnected player name, or null if not mapped
   */
  public String removePlayerMapping(long clientId) {
    String disconnectedPlayer = clientIdToPlayerName.remove(clientId);
    if (disconnectedPlayer != null) {
      playerNameToClientId.remove(disconnectedPlayer);
      playerNameToClientIdLower.remove(disconnectedPlayer.toLowerCase());
      playerNameToClientIdNormalized.remove(normalizeAliasKey(disconnectedPlayer));
      logger.info("Removed player mapping: {} -> {}", disconnectedPlayer, clientId);
    }
    return disconnectedPlayer;
  }

  /**
   * Resolve a target player name to a client ID using exact, lowercase, and normalized matching.
   * @return ResolvedTarget or null if not found
   */
  public ResolvedTarget resolveTargetClientId(String target) {
    Long targetClientId = playerNameToClientId.get(target);
    if (targetClientId != null) {
      return new ResolvedTarget(targetClientId, "exact");
    }
    targetClientId = playerNameToClientIdLower.get(target.toLowerCase());
    if (targetClientId != null) {
      return new ResolvedTarget(targetClientId, "lowercase");
    }
    targetClientId = playerNameToClientIdNormalized.get(normalizeAliasKey(target));
    if (targetClientId != null) {
      return new ResolvedTarget(targetClientId, "normalized");
    }
    return null;
  }

  /**
   * Get the player name for a client ID.
   */
  public String getPlayerName(long clientId) {
    return clientIdToPlayerName.get(clientId);
  }

  /**
   * Get all registered player names (for debug logging).
   */
  public Set<String> getRegisteredPlayerNames() {
    return playerNameToClientId.keySet();
  }

  /**
   * Clear all mappings (for shutdown cleanup).
   */
  public void clearAll() {
    playerNameToClientId.clear();
    playerNameToClientIdLower.clear();
    playerNameToClientIdNormalized.clear();
    clientIdToPlayerName.clear();
  }

  /**
   * Try to extract player alias from a client packet containing a chat message or command.
   * Chat packets are XML plists with "alias" and "message" keys.
   * Only updates the mapping when the message starts with "/" (a command).
   */
  public boolean tryExtractClientCommand(MemorySegment enetPacket, long clientId, int channelId) {
    try {
      var data = ENetPacket.data$get(enetPacket).asSlice(0, (int) ENetPacket.dataLength$get(enetPacket)).asByteBuffer();
      if (data.remaining() < 2) return false;

      byte packetId = data.get();

      byte[] remaining = new byte[data.remaining()];
      data.get(remaining);

      if (!isLikelyPlist(remaining)) {
        return false;
      }

      // Try to parse as plist
      NSDictionary dict;
      try {
        var parsed = BHHelper.parseProperty(remaining);
        if (!(parsed instanceof NSDictionary d)) return false;
        dict = d;
      } catch (Exception e) {
        return false; // Not a plist packet, expected for most packet types
      }

      var aliasObj = dict.get("alias");
      var messageObj = dict.get("message");
      if (aliasObj == null || messageObj == null) return false;

      String alias = aliasObj.toJavaObject(String.class);
      String message = messageObj.toJavaObject(String.class);
      if (alias == null || alias.isEmpty()) return false;

      // Only register mapping when player uses a command
      if (message != null && message.startsWith("/")) {
        registerPlayer(alias, clientId);
        logger.info("Mapped player '{}' -> clientId {}", alias, clientId);
        writeCommandEvent(alias, message);
        String lower = message.toLowerCase(Locale.ROOT);
        // Forward native server commands to the server (/give and /give-id handled by bot)
        if (lower.startsWith("/help")
            || lower.startsWith("/players")
            || lower.startsWith("/kick")
            || lower.startsWith("/ban-no-device")
            || lower.startsWith("/ban")
            || lower.startsWith("/unban")
            || lower.startsWith("/whitelist")
            || lower.startsWith("/unwhitelist")
            || lower.startsWith("/list-blacklist")
            || lower.startsWith("/list-whitelist")
            || lower.startsWith("/list-modlist")
            || lower.startsWith("/list-adminlist")
            || lower.startsWith("/clear-blacklist")
            || lower.startsWith("/clear-whitelist")
            || lower.startsWith("/clear-modlist")
            || lower.startsWith("/clear-adminlist")
            || lower.startsWith("/clear")
            || lower.startsWith("/pvp-on")
            || lower.startsWith("/pvp-off")
            || lower.startsWith("/load-lists")
            || lower.startsWith("/mod")
            || lower.startsWith("/unmod")
            || lower.startsWith("/admin")
            || lower.startsWith("/unadmin")
            || lower.startsWith("/repair")
            || lower.startsWith("/reset-owner")
            || lower.startsWith("/stop")
            || lower.startsWith("/save")) {
          return false;  // Forward to server
        }
        return true;  // Drop custom bot commands
      }
      // Also map on normal chat so we can whisper to players who haven't used / commands
      registerPlayer(alias, clientId);
    } catch (Exception e) {
      // Silently ignore - most packets aren't chat packets
    }
    return false;
  }

  /**
   * Send a private chat message to a specific client by crafting a ChatHistory packet.
   * The message appears as a SERVER message in the client's chat.
   */
  public void sendPrivateChatMessage(MemorySegment clientPeer, String message) {
    if (chatHistoryChannel < 0) {
      logger.warn("Cannot send private message - chat channel not yet captured");
      return;
    }
    try {
      NSDictionary root = new NSDictionary();
      if (chatPacketUsesMessagesArray) {
        // ChatHistory-style: {messages: [ {alias,date,message,playerID} ], photos: {}}
        NSArray messages = new NSArray(1);
        NSDictionary msg = new NSDictionary();
        msg.put("alias", new NSString("SERVER"));
        msg.put("date", new NSDate(new Date()));
        msg.put("message", new NSString(message));
        msg.put("playerID", new NSString("00000000000000000000000000000000"));
        messages.setValue(0, msg);
        root.put("messages", messages);
        root.put("photos", new NSDictionary());
      } else {
        // Single-message style: {alias,date,message,playerID}
        root.put("alias", new NSString("SERVER"));
        root.put("date", new NSDate(new Date()));
        root.put("message", new NSString(message));
        root.put("playerID", new NSString("00000000000000000000000000000000"));
      }

      // Serialize to XML plist
      var baos = new ByteArrayOutputStream();
      XMLPropertyListWriter.write(root, baos);
      byte[] plistBytes = baos.toByteArray();

      // Prepend packet ID byte (captured from server chat packet)
      byte[] packetData = new byte[1 + plistBytes.length];
      packetData[0] = chatPacketId;
      System.arraycopy(plistBytes, 0, packetData, 1, plistBytes.length);

      // Create ENet packet and send
      var arena = Arena.ofAuto();
      var dataSegment = arena.allocate(packetData.length);
      dataSegment.asByteBuffer().put(packetData);
      var enetPacket = ENet.enet_packet_create(dataSegment, packetData.length,
          ENet.ENET_PACKET_FLAG_RELIABLE());
      int result = ENet.enet_peer_send(clientPeer, (byte) chatHistoryChannel, enetPacket);
      if (result < 0) {
        logger.warn("Failed to send private message, enet_peer_send returned {}", result);
      }
    } catch (Exception e) {
      logger.error("Failed to craft private chat message", e);
    }
  }

  /**
   * Try to capture the chat channel from a server packet (for later PM delivery).
   */
  public void tryCaptureChatChannelFromServerPacket(MemorySegment enetPacket, int channelId, Packet detected) {
    if (detected instanceof ChatHistory && chatHistoryChannel < 0) {
      chatHistoryChannel = channelId;
      chatPacketId = ChatHistory.ID;
      chatPacketUsesMessagesArray = true;
      logger.info("Captured ChatHistory channel: {}", chatHistoryChannel);
      return;
    }

    try {
      var data = ENetPacket.data$get(enetPacket).asSlice(0, (int) ENetPacket.dataLength$get(enetPacket)).asByteBuffer();
      if (data.remaining() < 2) return;

      byte packetId = data.get();
      byte[] remaining = new byte[data.remaining()];
      data.get(remaining);

      if (!isLikelyPlist(remaining)) return;

      var parsed = BHHelper.parseProperty(remaining);
      if (!(parsed instanceof NSDictionary dict)) return;

      boolean hasMessages = dict.get("messages") != null;
      boolean hasSingleMessage = dict.get("message") != null && dict.get("alias") != null;
      if (!hasMessages && !hasSingleMessage) return;

      chatHistoryChannel = channelId;
      chatPacketId = packetId;
      chatPacketUsesMessagesArray = hasMessages;
      logger.info("Captured chat channel: {} (packetId=0x{}, messagesArray={})",
        chatHistoryChannel, HexFormat.of().formatHex(new byte[]{packetId}), chatPacketUsesMessagesArray);
    } catch (Exception e) {
      // ignore parsing failures
    }
  }

  /**
   * Whether the chat channel has been captured yet.
   */
  public boolean isChatChannelCaptured() {
    return chatHistoryChannel >= 0;
  }

  private void registerPlayer(String alias, long clientId) {
    playerNameToClientId.put(alias, clientId);
    playerNameToClientIdLower.put(alias.toLowerCase(), clientId);
    playerNameToClientIdNormalized.put(normalizeAliasKey(alias), clientId);
    clientIdToPlayerName.put(clientId, alias);
  }

  private static boolean isLikelyPlist(byte[] data) {
    if (data.length < 4) return false;
    if (BHHelper.isBinaryPropertyList(data)) return true;
    // XML plist starts with '<' (e.g., "<?xml" or "<plist")
    return data[0] == '<';
  }

  private static String normalizeAliasKey(String alias) {
    if (alias == null) return "";
    return Normalizer.normalize(alias, Normalizer.Form.NFKC).toLowerCase(Locale.ROOT);
  }

  private void writeCommandEvent(String playerName, String message) {
    try {
      String safeMessage = message.replace("\"", "\\\"");
      String line = STR."{\"player\":\"\{playerName}\",\"message\":\"\{safeMessage}\"}\n";
      Files.writeString(COMMAND_EVENT_FILE, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
    } catch (Exception e) {
      logger.warn("Failed to write command event for {}", playerName, e);
    }
  }
}
