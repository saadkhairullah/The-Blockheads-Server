package com.juanmuscaria.blockheads.network.packets.client;

import com.dd.plist.NSArray;
import com.dd.plist.NSData;
import com.dd.plist.NSNumber;
import com.dd.plist.NSObject;
import com.juanmuscaria.blockheads.network.BHHelper;
import com.juanmuscaria.blockheads.network.ItemDecoder;
import com.juanmuscaria.blockheads.network.packets.Packet;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.util.ArrayList;
import java.util.List;
import java.util.zip.GZIPInputStream;
import java.util.HexFormat;
import java.util.Arrays;

public class UpdatePlayerInventory extends Packet {
  private static final Logger logger = LoggerFactory.getLogger(UpdatePlayerInventory.class);
  public static final byte ID = 0x21;
  private int blockheadId;
  private byte[] headerBytes = new byte[7]; // Remaining 7 unknown bytes after short inventory id
  private Integer derivedUniqueId = null;
  private NSArray data; // Array of slots? Seems to change as you move around, baskets seems to be a dictionary

  public int getBlockheadId() { return blockheadId; }
  public NSArray getData() { return data; }
  public byte[] getHeaderBytes() { return headerBytes; }
  public Integer getDerivedUniqueId() { return derivedUniqueId; }

  @Override
  public void decode(ByteBuffer buffer) throws Exception {
    buffer.order(ByteOrder.LITTLE_ENDIAN);
    this.blockheadId = Byte.toUnsignedInt(buffer.get());
    buffer.get(headerBytes); // Remaining 7 unknown header bytes
    if (headerBytes.length >= 3) {
      // UniqueId is a 32-bit LE integer starting at byte 0 of the packet body
      int b0 = blockheadId & 0xFF;
      int b1 = headerBytes[0] & 0xFF;
      int b2 = headerBytes[1] & 0xFF;
      int b3 = headerBytes[2] & 0xFF;
      derivedUniqueId = (b3 << 24) | (b2 << 16) | (b1 << 8) | b0;
    }
    if (logger.isDebugEnabled()) {
      logger.debug("INV_HEADER: inventoryId={} derivedUniqueId={} headerHex={} headerBytes={}",
        blockheadId, derivedUniqueId, HexFormat.of().formatHex(headerBytes), Arrays.toString(headerBytes));
    }
    byte[] remaining = new byte[buffer.remaining()];
    buffer.get(remaining);
    var data = new ByteArrayOutputStream();
    new GZIPInputStream(new ByteArrayInputStream(remaining)).transferTo(data);
    this.data = BHHelper.parseProperty(data.toByteArray());
  }

  /**
   * Get decoded items from the inventory data.
   */
  public List<String> getDecodedItems() {
    List<String> items = new ArrayList<>();
    if (data == null) return items;

    for (int slot = 0; slot < data.count(); slot++) {
      NSObject obj = data.objectAtIndex(slot);

      // Slot can be: integer 0 (empty), or an array containing item data
      if (obj instanceof NSNumber) {
        // Empty slot
        continue;
      } else if (obj instanceof NSArray) {
        NSArray slotArray = (NSArray) obj;
        for (int i = 0; i < slotArray.count(); i++) {
          NSObject itemObj = slotArray.objectAtIndex(i);
          if (itemObj instanceof NSData) {
            byte[] itemBytes = ((NSData) itemObj).bytes();
            String decoded = ItemDecoder.decodeItem(itemBytes);
            items.add("slot" + slot + ": " + decoded);
          }
        }
      }
    }
    return items;
  }

  @Override
  public String toString() {
    List<String> decodedItems = getDecodedItems();
    String idPart = derivedUniqueId != null
            ? "blockheadId=" + derivedUniqueId + ", inventoryId=" + blockheadId
            : "inventoryId=" + blockheadId;
    if (decodedItems.isEmpty()) {
      return "UpdatePlayerInventory{" + idPart + "}";
    }
    return "UpdatePlayerInventory{" + idPart + ", items=" + decodedItems + "}";
  }
}
