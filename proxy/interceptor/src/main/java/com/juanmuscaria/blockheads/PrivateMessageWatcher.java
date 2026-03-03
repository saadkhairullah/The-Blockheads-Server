package com.juanmuscaria.blockheads;

import com.google.gson.Gson;
import com.google.gson.JsonObject;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.RandomAccessFile;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.io.FileInputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.util.ArrayList;
import java.util.List;
import java.util.concurrent.ConcurrentLinkedQueue;

/**
 * Watches a JSONL file for private message requests from Console-Loader.
 * Each line: {"target":"PlayerName","message":"text"}
 * Messages are enqueued and drained by the main ENet loop.
 */
public class PrivateMessageWatcher {
  private static final Logger logger = LoggerFactory.getLogger(PrivateMessageWatcher.class);
  private static final long MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB truncate threshold
  private static final long POLL_INTERVAL_MS = 100;

  public record PrivateMessage(String target, String message) {}

  private final Path filePath;
  private final ConcurrentLinkedQueue<PrivateMessage> queue = new ConcurrentLinkedQueue<>();
  private final Gson gson = new Gson();
  private final Thread watcherThread;
  private volatile boolean running = true;
  private long readOffset = 0;

  public PrivateMessageWatcher(String path) {
    this.filePath = Path.of(path);
    this.watcherThread = new Thread(this::watchLoop, "private-msg-watcher");
    this.watcherThread.setDaemon(true);
  }

  public void start() {
    watcherThread.start();
  }

  public void stop() {
    running = false;
    watcherThread.interrupt();
  }

  private void watchLoop() {
    // Initialize readOffset to end of file (skip existing content)
    try {
      if (Files.exists(filePath)) {
        readOffset = Files.size(filePath);
      }
    } catch (IOException e) {
      logger.warn("Failed to get initial file size, starting from 0", e);
      readOffset = 0;
    }

    logger.info("Private message watcher started, watching {}", filePath);

    while (running) {
      try {
        Thread.sleep(POLL_INTERVAL_MS);
        pollFile();
      } catch (InterruptedException e) {
        Thread.currentThread().interrupt();
        break;
      } catch (Exception e) {
        logger.warn("Error in private message watcher loop", e);
      }
    }

    logger.info("Private message watcher stopped");
  }

  private void pollFile() {
    if (!Files.exists(filePath)) {
      return;
    }

    try {
      long fileSize = Files.size(filePath);

      // Handle file truncation/rotation
      if (fileSize < readOffset) {
        readOffset = 0;
      }

      // Nothing new to read
      if (fileSize <= readOffset) {
        return;
      }

      // Read new content from readOffset using UTF-8 encoding
      // NOTE: RandomAccessFile.readLine() uses ISO-8859-1 which breaks Unicode (like •)
      try (FileInputStream fis = new FileInputStream(filePath.toFile())) {
        fis.skip(readOffset);
        try (BufferedReader reader = new BufferedReader(new InputStreamReader(fis, StandardCharsets.UTF_8))) {
          String line;
          while ((line = reader.readLine()) != null) {
            readOffset += line.getBytes(StandardCharsets.UTF_8).length + 1; // +1 for newline
            if (line.trim().isEmpty()) {
              continue;
            }
            try {
              JsonObject obj = gson.fromJson(line, JsonObject.class);
              String target = obj.has("target") ? obj.get("target").getAsString() : null;
              String message = obj.has("message") ? obj.get("message").getAsString() : null;
              if (target != null && message != null) {
                queue.add(new PrivateMessage(target, message));
                logger.debug("Queued private message for '{}': {}", target, message);
              }
            } catch (Exception e) {
              logger.debug("Skipping malformed JSON line: {}", line);
            }
          }
        }
      }

      // Truncate file if too large
      if (fileSize > MAX_FILE_SIZE) {
        try (FileChannel channel = FileChannel.open(filePath, StandardOpenOption.WRITE)) {
          channel.truncate(0);
          readOffset = 0;
          logger.info("Truncated private message file (was {} bytes)", fileSize);
        }
      }
    } catch (IOException e) {
      logger.warn("Error polling private message file", e);
    }
  }

  /**
   * Drain all pending messages. Called from main ENet loop each iteration.
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
