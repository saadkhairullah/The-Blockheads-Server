package com.juanmuscaria.blockheads;

import com.juanmuscaria.blockheads.network.InterceptedPacket;
import com.juanmuscaria.blockheads.network.Side;
import com.juanmuscaria.blockheads.network.packets.Packet;
import com.juanmuscaria.blockheads.network.packets.PacketRegistry;
import com.juanmuscaria.blockheads.network.packets.client.UpdatePlayerActionsAndState;
import com.juanmuscaria.blockheads.network.packets.client.UpdatePlayerInventory;
import com.juanmuscaria.blockheads.network.packets.client.ClientInformation;
import com.juanmuscaria.blockheads.network.packets.server.BlockheadsData;
import com.juanmuscaria.blockheads.network.packets.server.ChatHistory;
import com.juanmuscaria.foreign.enet.ENet;
import com.juanmuscaria.foreign.enet.ENetAddress;
import com.juanmuscaria.foreign.enet.ENetEvent;
import com.juanmuscaria.foreign.enet.ENetPacket;
import io.netty.util.collection.IntObjectHashMap;
import io.netty.util.collection.IntObjectMap;
import lombok.Getter;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import picocli.CommandLine;
import picocli.CommandLine.Command;
import picocli.CommandLine.Option;

import java.io.IOException;
import java.lang.foreign.Arena;
import java.lang.foreign.MemorySegment;
import java.util.HexFormat;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicInteger;


/**
 * Proxy blockheads connection and inspect what is going on under the hood
 */
@Command(name = "interceptor", mixinStandardHelpOptions = true, description = "Packet inspector for The Blockheads")
public class BHInterceptor implements Runnable {
  private static final Logger logger = LoggerFactory.getLogger(BHInterceptor.class);
  private static final int CHANNELS = 32; // Seems to be what is used by blockheads
  private static final AtomicBoolean initializedNatives = new AtomicBoolean();
  private static final AtomicInteger packetSession = new AtomicInteger();
  @Getter
  private final IntObjectMap<InterceptedPacket> packets = new IntObjectHashMap<>();
  @Option(names = {"--proxy-port", "-P"}, description = "The port that should be used by the proxy", defaultValue = "15153")
  private short proxyPort;
  @Option(names = {"--proxy-host", "-PH"}, description = "The host the proxy will listen to", defaultValue = "0.0.0.0")
  private String proxyHost;
  @Option(names = {"--server-port", "-S"}, description = "The server port", defaultValue = "15151")
  private short serverPort;
  @Option(names = {"--server-host", "-SH"}, description = "The server host", defaultValue = "127.0.0.1")
  private String serverHost;
  @Option(names = "-D", defaultValue = "false", hidden = true) // Used to export packet data for the GUI frontend
  private boolean forwardData;
  @Option(names = {"--max-clients", "-M"}, description = "Maximum number of concurrent clients", defaultValue = "32")
  private int maxClients;
  @Option(names = {"--private-messages-file"}, description = "Path to private messages JSONL file", defaultValue = "${BH_PRIVATE_MESSAGES_FILE:-private_messages.jsonl}")
  private String privateMessagesFile;
  @Option(names = {"--command-events-file"}, description = "Path to command events JSONL file", defaultValue = "${BH_COMMAND_EVENTS_FILE:-command_events.jsonl}")
  private String commandEventsFile;

  // Maps client peer address to their server connection info
  private final Map<Long, ClientConnection> clientConnections = new ConcurrentHashMap<>();

  // Client ID -> IP address mapping (for logging)
  private final Map<Long, String> clientIdToIpAddress = new ConcurrentHashMap<>();

  // Private message file watcher
  private PrivateMessageWatcher privateMessageWatcher;

  // UDS event server for pushing events to bot
  private UDSEventServer udsServer;

  // Holds a client's connection to the real server
  private record ClientConnection(MemorySegment serverHost, MemorySegment serverPeer, MemorySegment clientPeer) {}

  private static MemorySegment copyPackage(MemorySegment packet) {
    // Note, Enet already clones the input data!
    return ENet.enet_packet_create(ENetPacket.data$get(packet), ENetPacket.dataLength$get(packet), ENetPacket.flags$get(packet));
  }

  private static void loadLibraries() {
    if (!initializedNatives.getAndSet(true)) {
      try {
        NativeHelper.loadLibrary("libenet");
      } catch (Throwable e) {
        initializedNatives.set(false);
        throw e;
      }
    }
  }

  public static void main(String... args) {
    System.exit(new CommandLine(new BHInterceptor()).execute(args));
  }

  @Override
  public void run() {
    logger.info("Initializing proxy...");
    // C style error handling is a pain...
    int success;

    // Init native stuff
    loadLibraries();

    if ((success = ENet.enet_initialize()) != 0) {
      throw new IllegalStateException(STR."Unable to initialize ENet! Error code:\{success}");
    }

    // We don't need any fancy memory sharing here, create a confined allocator
    try (Arena allocator = Arena.ofConfined()) {
      MemorySegment proxyServer = null;
      var chatHandler = new ChatCommandHandler(commandEventsFile);

      try {
        var proxyAddress = ENetAddress.allocate(allocator);
        ENetAddress.port$set(proxyAddress, proxyPort);
        if (this.proxyHost.equals("0.0.0.0")) {
          ENetAddress.host$set(proxyAddress, ENet.ENET_HOST_ANY());
        } else {
          if ((success = ENet.enet_address_set_host(proxyAddress, allocator.allocateUtf8String(this.proxyHost))) != 0) {
            throw new IllegalStateException(STR."Native code error, unable to set proxy host! Error code:\{success}");
          }
        }

        var serverAddress = ENetAddress.allocate(allocator);
        ENetAddress.port$set(serverAddress, serverPort);
        if ((success = ENet.enet_address_set_host(serverAddress, allocator.allocateUtf8String(this.serverHost))) != 0) {
          throw new IllegalStateException(STR."Native code error, unable to set server host! Error code:\{success}");
        }

        // Allow multiple clients to connect
        proxyServer = ENet.enet_host_create(proxyAddress, maxClients, CHANNELS, 0, 0);
        if (proxyServer.address() == ENet.NULL().address()) {
          throw new IllegalStateException("Failed to create proxy server due to native error.");
        }

        var event = ENetEvent.allocate(allocator);

        // Start private message file watcher
        privateMessageWatcher = new PrivateMessageWatcher(privateMessagesFile);
        privateMessageWatcher.start();

        // Start UDS event server
        try {
          udsServer = new UDSEventServer(System.getProperty("bh.udsEventSocket", "/tmp/bh-events.sock"));
          udsServer.start();
          EventLogger.setUDSServer(udsServer);
          logger.info("UDS event server started");
        } catch (IOException e) {
          logger.warn("Failed to start UDS server, continuing without it", e);
        }

        logger.info("Proxy initialized (max {} clients)", maxClients);
        while (!Thread.interrupted()) {
          // Service the proxy server and forward client connection/packets
          while (ENet.enet_host_service(proxyServer, event, 10) != 0) {
            var type = ENetEvent.type$get(event);
            var eventPeer = ENetEvent.peer$get(event);
            long clientId = eventPeer.address();

            if (type == ENet.ENET_EVENT_TYPE_CONNECT()) {
              // Capture client IP address
              var peerAddress = com.juanmuscaria.foreign.enet.ENetPeer.address$slice(eventPeer);
              int hostInt = ENetAddress.host$get(peerAddress);
              String clientIp = String.format("%d.%d.%d.%d",
                  hostInt & 0xFF, (hostInt >> 8) & 0xFF, (hostInt >> 16) & 0xFF, (hostInt >> 24) & 0xFF);
              clientIdToIpAddress.put(clientId, clientIp);
              logger.info("Client {} connected to proxy from IP {}...", clientId, clientIp);

              // SECURITY: Block IPs from blocklist and known VPN/datacenter ranges
              if (SecurityHandler.isBlocked(clientIp)) {
                logger.warn("EXPLOIT BLOCKED: Rejecting connection from blocked IP: {}", clientIp);
                ENet.enet_peer_reset(eventPeer);
                clientIdToIpAddress.remove(clientId);
                continue;
              }

              // Create a dedicated server connection for this client
              var serverHost = ENet.enet_host_create(ENet.NULL(), 1, CHANNELS, 0, 0);
              if (serverHost.address() == ENet.NULL().address()) {
                logger.error("Failed to create server host for client {}", clientId);
                ENet.enet_peer_reset(eventPeer);
                continue;
              }

              var serverPeer = ENet.enet_host_connect(serverHost, serverAddress, CHANNELS, 0);
              if (serverPeer.address() == ENet.NULL().address()) {
                logger.error("Failed to connect to server for client {}", clientId);
                ENet.enet_host_destroy(serverHost);
                ENet.enet_peer_reset(eventPeer);
                continue;
              }

              clientConnections.put(clientId, new ClientConnection(serverHost, serverPeer, eventPeer));
              logger.info("Client {} now has server connection, total clients: {}", clientId, clientConnections.size());

            } else if (type == ENet.ENET_EVENT_TYPE_DISCONNECT()) {
              logger.info("Client {} disconnected from proxy", clientId);
              chatHandler.removePlayerMapping(clientId);
              // Clean up IP mapping
              clientIdToIpAddress.remove(clientId);
              var conn = clientConnections.remove(clientId);
              if (conn != null) {
                ENet.enet_host_destroy(conn.serverHost());
              }
              logger.info("Remaining clients: {}", clientConnections.size());

            } else if (type == ENet.ENET_EVENT_TYPE_RECEIVE()) {
              var packet = ENetEvent.packet$get(event);
              int channelId = ENetEvent.channelID$get(event);

              var packetData = ENetPacket.data$get(packet);
              byte packetId = packetData.get(java.lang.foreign.ValueLayout.JAVA_BYTE, 0);

              boolean shouldDrop = chatHandler.tryExtractClientCommand(packet, clientId, channelId);
              Packet detected = attemptPacketDetection(packet, channelId, Side.CLIENT);

              // Log ClientInformation for tracking exploiters
              if (detected instanceof ClientInformation clientInfo) {
                String ip = clientIdToIpAddress.getOrDefault(clientId, "unknown");
                SecurityHandler.logClientInformation(clientInfo, clientId, ip);
                // SECURITY: Check for exploit signatures and disconnect immediately
                String exploitReason = clientInfo.getExploitReason();
                if (exploitReason != null) {
                  logger.warn("EXPLOIT BLOCKED: Disconnecting client {} IP {} - {}", clientId, ip, exploitReason);
                  SecurityHandler.dumpMalformedPacket(packet, clientId, ip, "EXPLOIT: " + exploitReason);
                  ENet.enet_peer_disconnect(eventPeer, 0);
                  ENet.enet_packet_destroy(packet);
                  continue; // Don't forward to server
                }
              }

              // SECURITY: Drop malformed ClientInformation packets (0x1F) that failed to parse
              // These are exploit attempts that crash the server
              if (packetId == 0x1F && detected == null) {
                String ip = clientIdToIpAddress.getOrDefault(clientId, "unknown");
                logger.warn("EXPLOIT BLOCKED: Dropping malformed ClientInformation (0x1F) from client {} IP {}", clientId, ip);
                SecurityHandler.dumpMalformedPacket(packet, clientId, ip, "MALFORMED_CLIENT_INFO");
                ENet.enet_peer_disconnect(eventPeer, 0);
                ENet.enet_packet_destroy(packet);
                continue; // Don't forward to server
              }

              var conn = clientConnections.get(clientId);
              if (conn != null && !shouldDrop) {
                ENet.enet_peer_send(conn.serverPeer(), ENetEvent.channelID$get(event), copyPackage(packet));
              }
              ENet.enet_packet_destroy(packet);
            }
          }

          // Service all server connections and forward packets to respective clients
          for (var entry : clientConnections.entrySet()) {
            long clientId = entry.getKey();
            var conn = entry.getValue();

            while (ENet.enet_host_service(conn.serverHost(), event, 0) != 0) {
              var type = ENetEvent.type$get(event);
              if (type == ENet.ENET_EVENT_TYPE_CONNECT()) {
                logger.info("Server connected for client {}", clientId);
              } else if (type == ENet.ENET_EVENT_TYPE_DISCONNECT()) {
                logger.info("Server disconnected for client {}, killing client connection", clientId);
                ENet.enet_peer_reset(conn.clientPeer());
                // Will be cleaned up when client disconnect event fires
              } else if (type == ENet.ENET_EVENT_TYPE_RECEIVE()) {
                var packet = ENetEvent.packet$get(event);
                ENet.enet_peer_send(conn.clientPeer(), ENetEvent.channelID$get(event), copyPackage(packet));
                Packet detected = attemptPacketDetection(packet, ENetEvent.channelID$get(event), Side.SERVER);
                if (!chatHandler.isChatChannelCaptured()) {
                  chatHandler.tryCaptureChatChannelFromServerPacket(packet, ENetEvent.channelID$get(event), detected);
                }
                ENet.enet_packet_destroy(packet);
              }
            }
          }

          // Drain private messages and send to targeted clients
          if (privateMessageWatcher != null) {
            for (var pmsg : privateMessageWatcher.drainMessages()) {
              String target = pmsg.target();
              var resolved = chatHandler.resolveTargetClientId(target);
              if (resolved != null) {
                var conn = clientConnections.get(resolved.clientId());
                if (conn != null) {
                  chatHandler.sendPrivateChatMessage(conn.clientPeer(), pmsg.message());
                  logger.info("Sent private message to '{}' (match={}, clientId={})", target, resolved.matchType(), resolved.clientId());
                } else {
                  logger.warn("Private message target '{}' has no active connection (clientId={})", target, resolved.clientId());
                }
              } else {
                logger.warn("Private message target '{}' not found. Registered players: {}", target, chatHandler.getRegisteredPlayerNames());
              }
            }
          }
        }
        Thread.currentThread().interrupt(); // Restore interrupt status
      } finally {
        // Stop private message watcher
        if (privateMessageWatcher != null) {
          privateMessageWatcher.stop();
        }
        // Stop UDS event server
        if (udsServer != null) {
          udsServer.stop();
        }
        // Clean up all client connections
        for (var conn : clientConnections.values()) {
          if (conn.serverHost().address() != ENet.NULL().address()) {
            ENet.enet_host_destroy(conn.serverHost());
          }
        }
        clientConnections.clear();
        chatHandler.clearAll();
        if (proxyServer != null && proxyServer.address() != ENet.NULL().address()) {
          ENet.enet_host_destroy(proxyServer);
        }
        logger.info("Proxy interrupted, shutting down...");
        // Wrap in try-catch as FFM classes may be unloaded during JVM shutdown
        try {
          ENet.enet_deinitialize();
        } catch (NoClassDefFoundError | UnsatisfiedLinkError e) {
          // Ignore - JVM is shutting down and native classes are being unloaded
          logger.debug("Ignored cleanup error during shutdown: {}", e.getMessage());
        }
      }
    }
  }

  private Packet attemptPacketDetection(MemorySegment packet, int channel, Side direction) {
    // We create a slice of the memory, so java is aware of the actual bounds for the direct byte buffer
    var data = ENetPacket.data$get(packet).asSlice(0, (int) ENetPacket.dataLength$get(packet)).asByteBuffer();
    Packet detectedPacket = PacketRegistry.parsePacket(data, direction);
    data.rewind();
    var id = data.get();

    var rawData = new byte[data.limit()];
    data.rewind();
    data.get(rawData);

    if (this.forwardData) {
      var flags = ENetPacket.flags$get(packet);
      var session = packetSession.incrementAndGet();

      packets.put(session, new InterceptedPacket(id, rawData, detectedPacket, direction,
        PacketRegistry.getPacketClass(id, direction), flags, channel));
      MDC.put("packetSession", String.valueOf(session));
    }

    if (detectedPacket != null) {
        if (isImportantPacket(detectedPacket)) {
          logger.info("{} [{}] {}", direction.getPacketFlow(), HexFormat.of().formatHex(new byte[]{id}), detectedPacket.describePacket());
        } else if (logger.isDebugEnabled()) {
          logger.debug("{} [{}] {}", direction.getPacketFlow(), HexFormat.of().formatHex(new byte[]{id}), detectedPacket.describePacket());
        }

        // Log important events
        if (detectedPacket instanceof UpdatePlayerActionsAndState playerState) {
          PacketEventHandler.logPlayerEvents(playerState);
        }

        // Process chat history to extract player names from welcome messages
        if (detectedPacket instanceof ChatHistory chatHistory) {
          PacketEventHandler.processChatHistory(chatHistory);
        }

        // Process inventory updates to detect ground pickups/drops
        if (detectedPacket instanceof UpdatePlayerInventory inventoryUpdate) {
          PacketEventHandler.processInventoryUpdate(inventoryUpdate);
        }

        if (detectedPacket instanceof BlockheadsData blockheadsData) {
          PacketEventHandler.logBlockheadsData(blockheadsData);
        }

    } else if (logger.isDebugEnabled()) {
      // No packet detected, dump its raw data
      var content = "<EMPTY>";
      if (data.remaining() > 0) {
        var unknownContent = new byte[data.remaining() - 1];
        data.get(unknownContent);
        content = HexFormat.of().formatHex(unknownContent);
      }
      logger.debug("{} [{}] {}", direction.getPacketFlow(), HexFormat.of().formatHex(new byte[]{id}), content);
    }

    if (this.forwardData) {
      MDC.remove("packetSession");
    }

    return detectedPacket;
  }

  private boolean isImportantPacket(Packet packet) {
    return packet instanceof UpdatePlayerActionsAndState
        || packet instanceof UpdatePlayerInventory
        || packet instanceof BlockheadsData
        || packet instanceof ChatHistory
        || packet instanceof ClientInformation;
  }

}
