package com.juanmuscaria.blockheads.network.packets.client;

import com.dd.plist.NSDictionary;
import com.dd.plist.PropertyListParser;
import com.juanmuscaria.blockheads.network.packets.Packet;
import lombok.ToString;

import java.nio.ByteBuffer;

@ToString
public class ClientInformation extends Packet {
  public static final byte ID = 0x1F;
  String alias;
  String iCloudID;
  String gameCenterId;
  boolean local;
  boolean micOrSpeakerOn;
  int minorVersion;
  String playerID;
  String udidNew;
  boolean voiceConnected;
  String clientPassword; // Exploiters use this field - legitimate clients don't have it

  @Override
  public void encode(ByteBuffer buffer) {
    //TODO: Encoder
  }

  @Override
  public void decode(ByteBuffer buffer) throws Exception {
    byte[] remaining = new byte[buffer.remaining()];
    buffer.get(remaining);
    // Use PropertyListParser which handles both XML and binary plist formats
    var dict = (NSDictionary) PropertyListParser.parse(remaining);
    this.alias = safeGetString(dict, "alias");
    this.iCloudID = safeGetString(dict, "iCloudID");
    this.gameCenterId = safeGetString(dict, "gameCenterID");
    this.local = safeGetBoolean(dict, "local");
    this.micOrSpeakerOn = safeGetBoolean(dict, "micOrSpeakerOn");
    this.minorVersion = safeGetInt(dict, "minorVersion");
    this.playerID = safeGetString(dict, "playerID");
    this.udidNew = safeGetString(dict, "udidNew");
    this.voiceConnected = safeGetBoolean(dict, "voiceConnected");
    this.clientPassword = safeGetString(dict, "clientPassword");
  }

  // Blocked iCloudIDs - loaded from file
  private static final java.util.Set<String> BLOCKED_ICLOUD_IDS = loadBlockedICloudIDs();
  private static final java.nio.file.Path BLOCKED_ICLOUD_FILE =
      java.nio.file.Path.of(System.getProperty("bh.blockedICloudFile", "blocked_icloud.txt"));

  private static java.util.Set<String> loadBlockedICloudIDs() {
    java.util.Set<String> blocked = new java.util.HashSet<>();

    // Load from file
    try {
      if (java.nio.file.Files.exists(BLOCKED_ICLOUD_FILE)) {
        java.nio.file.Files.lines(BLOCKED_ICLOUD_FILE)
            .map(String::trim)
            .map(String::toLowerCase)
            .filter(line -> !line.isEmpty() && !line.startsWith("#"))
            .forEach(blocked::add);
      }
    } catch (Exception e) {
      // Silently ignore - file loading is optional
    }
    return blocked;
  }

  // Valid UDID pattern: 32 hexadecimal characters
  private static final java.util.regex.Pattern VALID_UDID_PATTERN =
      java.util.regex.Pattern.compile("^[a-f0-9]{32}$", java.util.regex.Pattern.CASE_INSENSITIVE);

  // Valid ID pattern: 32 hex chars (for playerID, iCloudID, gameCenterId)
  private static final java.util.regex.Pattern VALID_ID_PATTERN =
      java.util.regex.Pattern.compile("^[a-f0-9]{32}$", java.util.regex.Pattern.CASE_INSENSITIVE);

  /**
   * Check if this client looks like an exploit attempt.
   * Returns a reason string if suspicious, null if OK.
   */
  public String getExploitReason() {
    // 1. Has clientPassword field AT ALL - only exploiters have this key (even if empty)
    if (clientPassword != null) {
      return "has clientPassword field (key exists)";
    }

    // 2. Alias validation
    if (alias == null || alias.isEmpty()) {
      return "empty alias";
    }

    // Block IP-like aliases (exploit to get others banned)
    if (alias.equals("127.0.0.1") || alias.matches("\\d+\\.\\d+\\.\\d+\\.\\d+")) {
      return "alias looks like IP address: " + alias;
    }

    // Check for null bytes in alias
    if (alias.contains("\u0000")) {
      return "alias contains null byte";
    }

    // Check for control characters
    for (char c : alias.toCharArray()) {
      if (Character.isISOControl(c)) {
        return "alias contains control character";
      }
    }

    // Block whitespace in alias
    for (char c : alias.toCharArray()) {
      if (Character.isWhitespace(c)) {
        return "alias contains whitespace: " + alias;
      }
    }

    // Check if alias has only special characters (no alphanumeric)
    String alphanumOnly = alias.replaceAll("[^A-Za-z0-9]", "");
    if (alphanumOnly.isEmpty()) {
      return "alias has no alphanumeric characters: " + alias;
    }

    // Check for lowercase letters - game forces UPPERCASE
    for (char c : alias.toCharArray()) {
      if (Character.isLowerCase(c)) {
        return "alias contains lowercase: " + alias;
      }
    }

    // 3. UDID validation - must be 32 hex characters
    if (udidNew == null || udidNew.isEmpty()) {
      return "empty udidNew";
    }
    if (!VALID_UDID_PATTERN.matcher(udidNew).matches()) {
      return "invalid udidNew format (must be 32 hex chars): " + udidNew;
    }

    // 4. Block known exploiter iCloudIDs
    if (iCloudID != null && BLOCKED_ICLOUD_IDS.contains(iCloudID.toLowerCase())) {
      return "blocked iCloudID: " + iCloudID;
    }

    // 5. Empty playerID is suspicious
    if (playerID == null || playerID.isEmpty()) {
      return "empty playerID";
    }

    // 6. Validate ID formats - should be 32 hex characters
    if (!VALID_ID_PATTERN.matcher(playerID).matches()) {
      return "invalid playerID format (must be 32 hex chars): " + playerID;
    }
    if (iCloudID != null && !iCloudID.isEmpty() && !VALID_ID_PATTERN.matcher(iCloudID).matches()) {
      return "invalid iCloudID format (must be 32 hex chars): " + iCloudID;
    }
    if (gameCenterId != null && !gameCenterId.isEmpty() && !VALID_ID_PATTERN.matcher(gameCenterId).matches()) {
      return "invalid gameCenterId format (must be 32 hex chars): " + gameCenterId;
    }

    return null; // Looks OK
  }

  private String safeGetString(NSDictionary dict, String key) {
    var obj = dict.get(key);
    return obj != null ? obj.toJavaObject(String.class) : null;
  }

  private boolean safeGetBoolean(NSDictionary dict, String key) {
    var obj = dict.get(key);
    return obj != null ? obj.toJavaObject(Boolean.class) : false;
  }

  private int safeGetInt(NSDictionary dict, String key) {
    var obj = dict.get(key);
    return obj != null ? obj.toJavaObject(Integer.class) : 0;
  }

  public String getAlias() {
    return alias;
  }
  public String getICloudID() {
    return iCloudID;
  }
  public String getGameCenterId() {
    return gameCenterId;
  }
  public String getPlayerID() {
    return playerID;
  }
  public String getUdidNew() {
    return udidNew;
  }
  public String getClientPassword() {
    return clientPassword;
  }
}
