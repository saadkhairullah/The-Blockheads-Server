package com.juanmuscaria.blockheads.network.packets.server;

import com.juanmuscaria.blockheads.network.packets.Packet;

import java.nio.ByteBuffer;

// Not exactly sure, seems to remove dynamic objects from the world?
public class DynamicObjectRemove extends Packet {
  public static byte ID = 0x09;
  private byte keys;
  private int dataSize;

  public byte getKeys() {
    return keys;
  }

  @Override
  public void decode(ByteBuffer buffer) throws Exception {
    keys = buffer.get();
    dataSize = buffer.remaining();
    buffer.position(buffer.limit()); // Skip remaining data
  }

  @Override
  public String toString() {
    return "DynObjRemove{keys=" + keys + "}";
  }
}
