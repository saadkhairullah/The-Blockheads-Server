package com.juanmuscaria.blockheads;

import com.juanmuscaria.blockheads.network.packets.client.ClientInformation;
import com.juanmuscaria.foreign.enet.ENetPacket;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.foreign.MemorySegment;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.HexFormat;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Static security utilities: IP blocking, exploit logging, forensic packet dumps.
 */
public final class SecurityHandler {
  private static final Logger logger = LoggerFactory.getLogger(SecurityHandler.class);

  private static final Path BLOCKED_IPS_FILE = Path.of(System.getProperty("bh.blockedIpsFile", "blocked_ips.txt"));
  private static final Set<String> BLOCKED_IPS = loadBlockedIPs();
  static final Path CLIENT_INFO_LOG_FILE = Path.of(System.getProperty("bh.clientInfoLog", "client_info.jsonl"));
  static final Path MALFORMED_PACKET_FILE = Path.of(System.getProperty("bh.malformedPacketLog", "malformed_packets.log"));

  private SecurityHandler() {}

  private static Set<String> loadBlockedIPs() {
    Set<String> blocked = ConcurrentHashMap.newKeySet();

    // Load from file
    try {
      if (Files.exists(BLOCKED_IPS_FILE)) {
        try (var lines = Files.lines(BLOCKED_IPS_FILE)) {
          lines.map(String::trim)
              .filter(line -> !line.isEmpty() && !line.startsWith("#"))
              .forEach(blocked::add);
        }
        logger.info("Loaded {} blocked IPs from {}", blocked.size(), BLOCKED_IPS_FILE);
      }
    } catch (Exception e) {
      logger.warn("Failed to load blocked IPs from file: {}", e.getMessage());
    }
    return blocked;
  }

  /**
   * Check if an IP should be blocked (exact match from blocklist file).
   */
  public static boolean isBlocked(String ip) {
    return BLOCKED_IPS.contains(ip);
  }

  /**
   * Log ClientInformation packet data for tracking exploiters.
   * Logs: timestamp, IP, alias, iCloudID, playerID, udidNew, gameCenterId
   */
  public static void logClientInformation(ClientInformation clientInfo, long clientId, String ip) {
    try {
      String alias = clientInfo.getAlias() != null ? clientInfo.getAlias().replace("\"", "\\\"") : "";
      String iCloudID = clientInfo.getICloudID() != null ? clientInfo.getICloudID().replace("\"", "\\\"") : "";
      String playerID = clientInfo.getPlayerID() != null ? clientInfo.getPlayerID().replace("\"", "\\\"") : "";
      String udidNew = clientInfo.getUdidNew() != null ? clientInfo.getUdidNew().replace("\"", "\\\"") : "";
      String gameCenterId = clientInfo.getGameCenterId() != null ? clientInfo.getGameCenterId().replace("\"", "\\\"") : "";

      String timestamp = java.time.Instant.now().toString();
      String line = STR."""
{"time":"\{timestamp}","ip":"\{ip}","alias":"\{alias}","iCloudID":"\{iCloudID}","playerID":"\{playerID}","udidNew":"\{udidNew}","gameCenterId":"\{gameCenterId}","clientId":\{clientId}}
""";
      Files.writeString(CLIENT_INFO_LOG_FILE, line, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
      logger.info("CLIENT_INFO: alias={} ip={} iCloudID={} playerID={} udid={}", alias, ip, iCloudID, playerID, udidNew);
    } catch (Exception e) {
      logger.warn("Failed to log client information", e);
    }
  }

  /**
   * Dump malformed/suspicious packets for forensic analysis.
   */
  public static void dumpMalformedPacket(MemorySegment enetPacket, long clientId, String ip, String reason) {
    try {
      var data = ENetPacket.data$get(enetPacket);
      int length = (int) ENetPacket.dataLength$get(enetPacket);

      byte[] rawBytes = new byte[length];
      data.asSlice(0, length).asByteBuffer().get(rawBytes);

      String timestamp = java.time.Instant.now().toString();
      String logLine = STR."""
################################################################################
!!! MALFORMED PACKET DETECTED !!!
################################################################################
TIME: \{timestamp}
REASON: \{reason}
CLIENT_ID: \{clientId}
IP: \{ip}
LENGTH: \{length} bytes
HEX DUMP:
\{formatHexDump(rawBytes)}
RAW HEX (single line):
\{HexFormat.of().formatHex(rawBytes)}
################################################################################
""";

      Files.writeString(MALFORMED_PACKET_FILE, logLine, StandardOpenOption.CREATE, StandardOpenOption.APPEND);
      logger.warn("MALFORMED_PACKET: Dumped {} bytes from IP {} to {}", length, ip, MALFORMED_PACKET_FILE);
    } catch (Exception e) {
      logger.warn("Failed to dump malformed packet: {}", e.getMessage());
    }
  }

  /**
   * Format bytes as a hex dump with offset, hex, and ASCII columns.
   */
  static String formatHexDump(byte[] bytes) {
    StringBuilder sb = new StringBuilder();
    for (int i = 0; i < bytes.length; i += 16) {
      // Offset
      sb.append(String.format("%04x: ", i));

      // Hex bytes
      for (int j = 0; j < 16; j++) {
        if (i + j < bytes.length) {
          sb.append(String.format("%02x ", bytes[i + j]));
        } else {
          sb.append("   ");
        }
        if (j == 7) sb.append(" "); // Extra space in middle
      }

      sb.append(" |");

      // ASCII
      for (int j = 0; j < 16 && i + j < bytes.length; j++) {
        byte b = bytes[i + j];
        if (b >= 32 && b < 127) {
          sb.append((char) b);
        } else {
          sb.append('.');
        }
      }

      sb.append("|\n");
    }
    return sb.toString();
  }
}
