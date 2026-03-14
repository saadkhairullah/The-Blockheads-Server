package com.juanmuscaria.blockheads;

import com.juanmuscaria.blockheads.network.BHHelper;
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

  public int getClientCount() {
    return clients.size();
  }
}
