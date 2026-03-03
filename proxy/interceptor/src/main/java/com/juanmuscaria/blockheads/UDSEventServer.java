package com.juanmuscaria.blockheads;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.IOException;
import java.io.OutputStream;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.ByteBuffer;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Unix Domain Socket server for pushing events to the bot.
 * Events are pushed as newline-delimited JSON.
 */
public class UDSEventServer {
  private static final Logger log = LoggerFactory.getLogger(UDSEventServer.class);

  private final Path socketPath;
  private ServerSocketChannel serverChannel;
  private final CopyOnWriteArrayList<SocketChannel> clients = new CopyOnWriteArrayList<>();
  private final ExecutorService acceptorThread = Executors.newSingleThreadExecutor();
  private volatile boolean running = false;

  public UDSEventServer(String socketPath) {
    this.socketPath = Path.of(socketPath);
  }

  public void start() throws IOException {
    // Clean up old socket file if exists
    Files.deleteIfExists(socketPath);

    UnixDomainSocketAddress address = UnixDomainSocketAddress.of(socketPath);
    serverChannel = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
    serverChannel.bind(address);
    running = true;

    log.info("UDS Event Server listening on {}", socketPath);

    // Accept connections in background thread
    acceptorThread.submit(() -> {
      while (running) {
        try {
          SocketChannel client = serverChannel.accept();
          client.configureBlocking(false);
          clients.add(client);
          log.info("UDS client connected, total clients: {}", clients.size());
        } catch (IOException e) {
          if (running) {
            log.error("Error accepting UDS connection", e);
          }
        }
      }
    });
  }

  public void stop() {
    running = false;
    acceptorThread.shutdownNow();

    for (SocketChannel client : clients) {
      try {
        client.close();
      } catch (IOException ignored) {}
    }
    clients.clear();

    try {
      if (serverChannel != null) {
        serverChannel.close();
      }
    } catch (IOException ignored) {}

    try {
      Files.deleteIfExists(socketPath);
    } catch (IOException ignored) {}

    log.info("UDS Event Server stopped");
  }

  /**
   * Broadcast an event to all connected clients.
   * Event is sent as JSON + newline.
   */
  public void broadcast(String jsonEvent) {
    if (clients.isEmpty()) return;

    String message = jsonEvent + "\n";
    ByteBuffer buffer = ByteBuffer.wrap(message.getBytes(StandardCharsets.UTF_8));

    for (SocketChannel client : clients) {
      try {
        buffer.rewind();
        while (buffer.hasRemaining()) {
          client.write(buffer);
        }
      } catch (IOException e) {
        // Client disconnected
        log.debug("UDS client disconnected");
        clients.remove(client);
        try {
          client.close();
        } catch (IOException ignored) {}
      }
    }
  }

  /**
   * Send a player join event.
   */
  public void sendPlayerJoin(String playerName, String playerId, String ip) {
    String json = String.format(
      "{\"type\":\"join\",\"player\":\"%s\",\"id\":\"%s\",\"ip\":\"%s\",\"time\":%d}",
      escapeJson(playerName), escapeJson(playerId), escapeJson(ip), System.currentTimeMillis()
    );
    broadcast(json);
  }

  /**
   * Send a player leave event.
   */
  public void sendPlayerLeave(String playerName, String playerId) {
    String json = String.format(
      "{\"type\":\"leave\",\"player\":\"%s\",\"id\":\"%s\",\"time\":%d}",
      escapeJson(playerName), escapeJson(playerId), System.currentTimeMillis()
    );
    broadcast(json);
  }

  /**
   * Send a chat message event.
   */
  public void sendChat(String playerName, String message) {
    String json = String.format(
      "{\"type\":\"chat\",\"player\":\"%s\",\"message\":\"%s\",\"time\":%d}",
      escapeJson(playerName), escapeJson(message), System.currentTimeMillis()
    );
    broadcast(json);
  }

  /**
   * Send a position update event.
   */
  public void sendPosition(String playerName, int blockheadId, double x, double y) {
    String json = String.format(
      "{\"type\":\"position\",\"player\":\"%s\",\"blockheadId\":%d,\"x\":%.2f,\"y\":%.2f,\"time\":%d}",
      escapeJson(playerName), blockheadId, x, y, System.currentTimeMillis()
    );
    broadcast(json);
  }

  /**
   * Send a command event (player typed /something).
   */
  public void sendCommand(String playerName, String command) {
    String json = String.format(
      "{\"type\":\"command\",\"player\":\"%s\",\"command\":\"%s\",\"time\":%d}",
      escapeJson(playerName), escapeJson(command), System.currentTimeMillis()
    );
    broadcast(json);
  }

  /**
   * Send raw packet info (for debugging/RE).
   */
  public void sendPacketInfo(String direction, int packetId, int length) {
    String json = String.format(
      "{\"type\":\"packet\",\"direction\":\"%s\",\"packetId\":%d,\"length\":%d,\"time\":%d}",
      direction, packetId, length, System.currentTimeMillis()
    );
    broadcast(json);
  }

  private static String escapeJson(String s) {
    if (s == null) return "";
    return s.replace("\\", "\\\\")
            .replace("\"", "\\\"")
            .replace("\n", "\\n")
            .replace("\r", "\\r")
            .replace("\t", "\\t");
  }

  public int getClientCount() {
    return clients.size();
  }
}
