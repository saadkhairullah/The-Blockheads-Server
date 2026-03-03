package com.juanmuscaria.blockheads.network.packets.client;

import com.dd.plist.NSArray;
import com.dd.plist.NSDictionary;
import com.dd.plist.NSNumber;
import com.dd.plist.NSObject;
import com.dd.plist.NSString;
import com.juanmuscaria.blockheads.network.BHHelper;
import com.juanmuscaria.blockheads.network.ItemDecoder;
import com.juanmuscaria.blockheads.network.packets.Packet;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;

// Seems to contain data about blockheads, what they are doing and their state
public class UpdatePlayerActionsAndState extends Packet {
  public static final byte ID = 0x20;
  public NSDictionary data;

  @Override
  public void encode(ByteBuffer buffer) {

  }

  @Override
  public void decode(ByteBuffer buffer) throws Exception {
    byte[] remaining = new byte[buffer.remaining()];
    buffer.get(remaining);
    var data = new ByteArrayOutputStream();
    new GZIPInputStream(new ByteArrayInputStream(remaining)).transferTo(data);
    this.data = BHHelper.parseProperty(data.toByteArray());
  }

  /**
   * Extract player info in a clean format.
   */
  public List<PlayerInfo> getPlayers() {
    List<PlayerInfo> players = new ArrayList<>();
    if (data == null) return players;

    NSObject dynObj = data.get("dynamicObjects");
    if (!(dynObj instanceof NSArray)) return players;

    NSArray dynamicObjects = (NSArray) dynObj;
    for (int i = 0; i < dynamicObjects.count(); i++) {
      NSObject obj = dynamicObjects.objectAtIndex(i);
      if (!(obj instanceof NSDictionary)) continue;

      NSDictionary playerDict = (NSDictionary) obj;
      PlayerInfo info = new PlayerInfo();

      if (logger.isDebugEnabled()) {
        logger.debug("PLAYER_STATE keys: {}", java.util.Arrays.toString(playerDict.allKeys()));
        for (String key : playerDict.allKeys()) {
          NSObject val = playerDict.get(key);
          if (val instanceof NSNumber) {
            int num = ((NSNumber) val).intValue();
            logger.debug("  {}=NSNumber({})", key, num);
          } else if (val instanceof NSString) {
            logger.debug("  {}=NSString({})", key, ((NSString) val).getContent());
          }
        }
      }

      // Available keys: interactionItemSubIndex, skinOptions, doubleTimeUnlocked, state, selectedToolIndex,
      // floatPos, actions, pos_y, clothingIncrementTimer, interactionItemIndex, uniqueID, name, pos_x
      // Note: Player account name is NOT in dynamicObjects - only blockhead name ("name" field)

      // Blockhead name
      NSObject nameObj = playerDict.get("name");
      if (nameObj instanceof NSString) {
        info.blockheadName = ((NSString) nameObj).getContent();
      }

      // Player/owner name (the actual account name)
      NSObject ownerObj = playerDict.get("owner");
      if (ownerObj instanceof NSString) {
        info.playerName = ((NSString) ownerObj).getContent();
      }
      // Fallback: try "playerName" key
      if (info.playerName.equals("?")) {
        NSObject playerNameObj = playerDict.get("playerName");
        if (playerNameObj instanceof NSString) {
          info.playerName = ((NSString) playerNameObj).getContent();
        }
      }

      // Position
      NSObject posX = playerDict.get("pos_x");
      NSObject posY = playerDict.get("pos_y");
      if (posX instanceof NSNumber) info.x = ((NSNumber) posX).intValue();
      if (posY instanceof NSNumber) info.y = ((NSNumber) posY).intValue();

      // Float position (more precise)
      NSObject floatPos = playerDict.get("floatPos");
      if (floatPos instanceof NSArray) {
        NSArray fp = (NSArray) floatPos;
        if (fp.count() >= 2) {
          NSObject fx = fp.objectAtIndex(0);
          NSObject fy = fp.objectAtIndex(1);
          if (fx instanceof NSNumber) info.floatX = ((NSNumber) fx).floatValue();
          if (fy instanceof NSNumber) info.floatY = ((NSNumber) fy).floatValue();
        }
      }

      // Unique ID
      NSObject uid = playerDict.get("uniqueID");
      if (uid instanceof NSNumber) info.uniqueId = ((NSNumber) uid).intValue();

      // Short inventory id (0-255) if present in dynamicObjects
      info.inventoryId = extractInventoryId(playerDict);

      // Current action (check if doing something)
      NSObject actionsObj = playerDict.get("actions");
      if (actionsObj instanceof NSArray) {
        NSArray actions = (NSArray) actionsObj;
        if (actions.count() > 0) {
          NSObject firstAction = actions.objectAtIndex(0);
          if (firstAction instanceof NSDictionary) {
            NSDictionary action = (NSDictionary) firstAction;
            // Check interaction type
            NSObject itemType = action.get("interactionItemType");
            if (itemType instanceof NSNumber) {
              int typeId = ((NSNumber) itemType).intValue();
              info.action = "using " + ItemDecoder.getItemName(typeId);
            }
            // Check inventory change
            NSObject invChange = action.get("inventoryChange");
            if (invChange instanceof NSDictionary) {
              NSDictionary changes = (NSDictionary) invChange;
              if (changes.count() > 0) {
                StringBuilder sb = new StringBuilder("inv:");
                for (String key : changes.allKeys()) {
                  int itemId = Integer.parseInt(key);
                  NSObject val = changes.get(key);
                  int delta = (val instanceof NSNumber) ? ((NSNumber) val).intValue() : 0;
                  String itemName = ItemDecoder.getItemName(itemId);
                  sb.append(itemName).append(delta > 0 ? "+" : "").append(delta).append(",");

                  // Store for external access
                  info.addInventoryChange(itemId, itemName, delta);
                }
                info.inventoryChange = sb.toString();
              }
            }
          }
        }
      }

      players.add(info);
    }
    return players;
  }

  private int extractInventoryId(NSDictionary playerDict) {
    String[] keys = {
      "id",
      "objectID",
      "objectId",
      "dynamicObjectID",
      "dynObjectID",
      "playerID",
      "playerId",
      "blockheadId"
    };
    for (String key : keys) {
      NSObject obj = playerDict.get(key);
      if (obj instanceof NSNumber) {
        int value = ((NSNumber) obj).intValue();
        if (value >= 0 && value <= 255) {
          return value;
        }
      }
    }
    return -1;
  }

  @Override
  public String toString() {
    List<PlayerInfo> players = getPlayers();
    if (players.isEmpty()) {
      return "PlayerState{empty}";
    }
    StringBuilder sb = new StringBuilder("PlayerState{");
    for (int i = 0; i < players.size(); i++) {
      if (i > 0) sb.append(", ");
      sb.append(players.get(i));
    }
    sb.append("}");
    return sb.toString();
  }

  public static class PlayerInfo {
    public String playerName = "?";      // The player's account/alias name
    public String blockheadName = "?";   // The blockhead's name
    public int x, y;
    public float floatX, floatY;
    public int uniqueId;
    public int inventoryId = -1;         // Short inventory id (0-255) when available
    public String action;
    public String inventoryChange;
    public List<InventoryDelta> inventoryDeltas = new ArrayList<>();

    // For backward compatibility - returns playerName if available, else blockheadName
    public String name() {
      if (!playerName.equals("?")) return playerName;
      return blockheadName;
    }

    public void addInventoryChange(int itemId, String itemName, int delta) {
      inventoryDeltas.add(new InventoryDelta(itemId, itemName, delta));
    }

    @Override
    public String toString() {
      StringBuilder sb = new StringBuilder();
      sb.append(playerName);
      if (!blockheadName.equals("?") && !blockheadName.equals(playerName)) {
        sb.append(" (").append(blockheadName).append(")");
      }
      sb.append("@(").append(x).append(",").append(y).append(")");
      if (action != null) sb.append(" [").append(action).append("]");
      if (inventoryChange != null) sb.append(" ").append(inventoryChange);
      return sb.toString();
    }
  }

  public static class InventoryDelta {
    public final int itemId;
    public final String itemName;
    public final int delta; // positive = pickup, negative = drop

    public InventoryDelta(int itemId, String itemName, int delta) {
      this.itemId = itemId;
      this.itemName = itemName;
      this.delta = delta;
    }
  }
}
