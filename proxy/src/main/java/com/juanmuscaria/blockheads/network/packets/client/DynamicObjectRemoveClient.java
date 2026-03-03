package com.juanmuscaria.blockheads.network.packets.client;

import com.dd.plist.NSArray;
import com.juanmuscaria.blockheads.network.BHHelper;
import com.juanmuscaria.blockheads.network.packets.Packet;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.ByteBuffer;
import java.util.zip.GZIPInputStream;


public class DynamicObjectRemoveClient extends Packet {
  public static byte ID = 0x0c;
  private byte keys;
  private NSArray data;

  public byte getKeys() {
    return keys;
  }

  public int getObjectCount() {
    return (data != null) ? data.count() : 0;
  }

  @Override
  public void decode(ByteBuffer buffer) throws Exception {
    keys = buffer.get();
    byte[] remaining = new byte[buffer.remaining()];
    buffer.get(remaining);
    var data = new ByteArrayOutputStream();
    new GZIPInputStream(new ByteArrayInputStream(remaining)).transferTo(data);
    this.data = BHHelper.parseProperty(data.toByteArray());
  }

  @Override
  public String toString() {
    int count = (data != null) ? data.count() : 0;
    return "DynObjRemoveClient{keys=" + keys + ", objects=" + count + "}";
  }
}
