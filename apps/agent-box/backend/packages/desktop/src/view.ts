import type { IncomingMessage, Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { WebSocketServer, WebSocket } from "ws";
import type { DesktopService } from "./service.js";
/** Binary view transport. The owned WayVNC process enforces --disable-input. */
export function attachDesktopViewer(options: {
  server: Server;
  desktops: DesktopService;
  authenticate(request: IncomingMessage): boolean;
}) {
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 128 * 1024,
    handleProtocols: (protocols) =>
      protocols.has("binary") ? "binary" : false,
  });
  const connections = new Set<{ profileId: string; close(): void }>();
  let closed = false;
  let shutdown: Promise<void> | undefined;
  const upgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const reject = (status: number) => {
      socket.end(
        `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
        () => socket.destroy(),
      );
    };
    socket.on("error", () => socket.destroy());
    if (
      closed ||
      request.headers.origin !== undefined ||
      !options.authenticate(request)
    ) {
      reject(401);
      return;
    }
    let url: URL;
    try {
      url = new URL(request.url ?? "/", "http://localhost");
    } catch {
      reject(400);
      return;
    }
    const parts = url.pathname.split("/");
    if (
      url.search ||
      parts.length !== 6 ||
      parts[1] !== "profiles" ||
      parts[3] !== "desktop" ||
      parts[5] !== "view"
    ) {
      reject(404);
      return;
    }
    const profileId = parts[2]!,
      generation = parts[4]!;
    let path: string;
    try {
      path = options.desktops.access(profileId, generation).vncSocket;
    } catch {
      reject(409);
      return;
    }
    if (
      connections.size >= 64 ||
      [...connections].filter((item) => item.profileId === profileId).length >=
        4
    ) {
      reject(429);
      return;
    }
    let ws: WebSocket | undefined;
    let ended = false;
    const upstream = connect(path);
    const current = () => {
      try {
        return (
          !closed &&
          options.desktops.access(profileId, generation).vncSocket === path
        );
      } catch {
        return false;
      }
    };
    const close = () => {
      if (ended) return;
      ended = true;
      clearInterval(timer);
      connections.delete(entry);
      upstream.destroy();
      ws?.terminate();
      socket.destroy();
    };
    const entry = { profileId, close };
    connections.add(entry);
    const timer = setInterval(() => {
      if (!current()) close();
    }, 250);
    timer.unref();
    upstream.setTimeout(5000, () => close());
    upstream.once("connect", () => {
      upstream.setTimeout(0);
      if (!current()) {
        close();
        return;
      }
      try {
        wss.handleUpgrade(request, socket, head, (client) => {
          ws = client;
          client.on("error", close);
          client.on("close", close);
          client.on("message", (data, binary) => {
            if (!binary || !current() || upstream.writableLength > 128 * 1024) {
              close();
              return;
            }
            const buffer = Array.isArray(data)
              ? Buffer.concat(data)
              : Buffer.from(data as ArrayBuffer);
            if (buffer.length + upstream.writableLength > 128 * 1024) {
              close();
              return;
            }
            upstream.write(buffer);
          });
        });
      } catch {
        close();
      }
    });
    upstream.on("data", (data) => {
      if (
        !ws ||
        ws.readyState !== WebSocket.OPEN ||
        !current() ||
        ws.bufferedAmount + data.length > 8 * 1024 * 1024
      ) {
        close();
        return;
      }
      ws.send(data, { binary: true }, (error) => {
        if (error) close();
      });
    });
    upstream.on("error", close);
    upstream.on("close", close);
    socket.on("close", close);
  };
  options.server.on("upgrade", upgrade);
  return {
    close() {
      if (shutdown) return shutdown;
      closed = true;
      options.server.off("upgrade", upgrade);
      for (const connection of connections) connection.close();
      shutdown = new Promise<void>((resolve, reject) =>
        wss.close((error) => (error ? reject(error) : resolve())),
      );
      return shutdown;
    },
  };
}
