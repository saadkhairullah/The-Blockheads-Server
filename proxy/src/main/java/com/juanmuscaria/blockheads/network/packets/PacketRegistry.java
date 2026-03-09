package com.juanmuscaria.blockheads.network.packets;

import com.juanmuscaria.blockheads.network.Side;
import com.juanmuscaria.blockheads.network.packets.client.*;
import com.juanmuscaria.blockheads.network.packets.server.*;
import it.unimi.dsi.fastutil.bytes.Byte2ObjectOpenHashMap;
import lombok.SneakyThrows;

import java.nio.ByteBuffer;

public class PacketRegistry {
  private static final Byte2ObjectOpenHashMap<Class<? extends Packet>> serverPackets = new Byte2ObjectOpenHashMap<>();
  private static final Byte2ObjectOpenHashMap<Class<? extends Packet>> clientPackets = new Byte2ObjectOpenHashMap<>();

  // Packet definition
  static {
    serverPackets.put(WorldId.ID, WorldId.class);
    serverPackets.put(ServerInformation.ID, ServerInformation.class);
    serverPackets.put(WorldChunk.ID, WorldChunk.class);
    serverPackets.put(BlockheadsData.ID, BlockheadsData.class);
    serverPackets.put(ChatHistory.ID, ChatHistory.class);
    serverPackets.put(DynamicObjectCreate.ID, DynamicObjectCreate.class);
    serverPackets.put(DynamicObjectUpdate.ID, DynamicObjectUpdate.class);
    serverPackets.put(DynamicObjectRemove.ID, DynamicObjectRemove.class);
    serverPackets.put(KeepAliveResponse.ID, KeepAliveResponse.class);

    clientPackets.put(ClientInformation.ID, ClientInformation.class);
    clientPackets.put(RequestWorldChunk.ID, RequestWorldChunk.class);
    clientPackets.put(RequestChatHistory.ID, RequestChatHistory.class);
    clientPackets.put(DynamicObjectCreateClient.ID, DynamicObjectCreateClient.class);
    clientPackets.put(DynamicObjectUpdateClient.ID, DynamicObjectUpdateClient.class);
    clientPackets.put(KeepAlive.ID, KeepAlive.class);
    clientPackets.put(UpdatePlayerActionsAndState.ID, UpdatePlayerActionsAndState.class);
    clientPackets.put(DynamicObjectRemoveClient.ID, DynamicObjectRemoveClient.class);
    clientPackets.put(UpdatePlayerInventory.ID, UpdatePlayerInventory.class);
  }

  /**
   * Parses a blockheads packet from given buffer
   *
   * @param buffer The buffer to parse from
   * @param from   The side the packet is from
   * @return The parsed packet, or null if it could not be parsed
   */
  // Max packet size to parse (64KB) - prevents OOM from malicious oversized packets
  private static final int MAX_PACKET_SIZE = 64 * 1024;

  @SneakyThrows(ReflectiveOperationException.class)
  public static Packet parsePacket(ByteBuffer buffer, Side from) {
    // SECURITY: Reject oversized packets before allocating memory
    if (buffer.remaining() > MAX_PACKET_SIZE) {
      Packet.logger.warn("Rejecting oversized packet: {} bytes (max {})", buffer.remaining(), MAX_PACKET_SIZE);
      return null;
    }

    byte id = buffer.get();
    var packetClass = getPacketClass(id, from);
    if (packetClass != null) {
      var packet = packetClass.getConstructor().newInstance();
      try {
        packet.decode(buffer);
        return packet;
      } catch (Throwable e) {
        // Catch Throwable to handle OOM and other Errors, not just Exceptions
        Packet.logger.error("Failed to parse packet (id=0x{}): {}", String.format("%02X", id), e.getMessage());
      }
    }
    return null;
  }

  public static Class<? extends Packet> getPacketClass(byte id, Side side) {
    if (side == Side.CLIENT) {
      return clientPackets.get(id);
    } else {
      return serverPackets.get(id);
    }
  }
}
