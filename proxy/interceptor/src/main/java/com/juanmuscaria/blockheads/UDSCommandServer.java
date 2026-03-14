package com.juanmuscaria.blockheads;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.net.StandardProtocolFamily;
import java.net.UnixDomainSocketAddress;
import java.nio.channels.Channels;
import java.nio.channels.ServerSocketChannel;
import java.nio.channels.SocketChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/**
 * Accepts command connections from the bot via Unix Domain Socket.
 * Commands arrive as newline-delimited JSON.
 *
 * Supported command types:
 *   {"type":"private_message","target":"PlayerName","message":"Hello!"}
 *
 * Messages are enqueued and drained by the main ENet loop each tick.
 */
public class UDSCommandServer {
  private static final Logger log = LoggerFactory.getLogger(UDSCommandServer.class);

  public record PrivateMessage(String target, String message) {}

  private final Path socketPath;
  private ServerSocketChannel serverChannel;
  private final ConcurrentLinkedQueue<PrivateMessage> queue = new ConcurrentLinkedQueue<>();
  private final ExecutorService executor = Executors.newCachedThreadPool(r -> {
    Thread t = new Thread(r, "cmd-server");
    t.setDaemon(true);
    return t;
  });
  private final Gson gson = new Gson();
  private volatile boolean running = false;

  public UDSCommandServer(String socketPath) {
    this.socketPath = Path.of(socketPath);
  }

  public void start() throws IOException {
    Files.deleteIfExists(socketPath);

    UnixDomainSocketAddress address = UnixDomainSocketAddress.of(socketPath);
    serverChannel = ServerSocketChannel.open(StandardProtocolFamily.UNIX);
    serverChannel.bind(address);
    running = true;

    log.info("UDS Command Server listening on {}", socketPath);

    executor.submit(() -> {
      while (running) {
        try {
          SocketChannel client = serverChannel.accept();
          log.info("Bot connected to command socket");
          executor.submit(() -> handleClient(client));
        } catch (IOException e) {
          if (running) log.error("Error accepting command connection", e);
        }
      }
    });
  }

  public void stop() {
    running = false;
    executor.shutdownNow();
    try {
      if (serverChannel != null) serverChannel.close();
    } catch (IOException ignored) {}
    try {
      Files.deleteIfExists(socketPath);
    } catch (IOException ignored) {}
    log.info("UDS Command Server stopped");
  }

  private void handleClient(SocketChannel client) {
    try (BufferedReader reader = new BufferedReader(
        new InputStreamReader(Channels.newInputStream(client), StandardCharsets.UTF_8))) {
      String line;
      while ((line = reader.readLine()) != null) {
        if (line.isBlank()) continue;
        try {
          JsonObject obj = gson.fromJson(line, JsonObject.class);
          String type = obj.has("type") ? obj.get("type").getAsString() : null;
          if ("private_message".equals(type)) {
            String target = obj.has("target") ? obj.get("target").getAsString() : null;
            String message = obj.has("message") ? obj.get("message").getAsString() : null;
            if (target != null && message != null) {
              queue.add(new PrivateMessage(target, message));
              log.debug("Queued private message for '{}'", target);
            }
          } else {
            log.debug("Unknown command type: {}", type);
          }
        } catch (Exception e) {
          log.debug("Skipping malformed command: {}", line);
        }
      }
    } catch (IOException e) {
      log.info("Bot disconnected from command socket");
    }
  }

  /**
   * Drain all pending messages. Called from the main ENet loop each tick.
   * Non-blocking.
   */
  public List<PrivateMessage> drainMessages() {
    List<PrivateMessage> result = new ArrayList<>();
    PrivateMessage msg;
    while ((msg = queue.poll()) != null) {
      result.add(msg);
    }
    return result;
  }
}
