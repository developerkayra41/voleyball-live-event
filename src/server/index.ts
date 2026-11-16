import express from "express";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "socket.io";
import type { ClientToServer, ServerToClient, SocketAuth } from "../shared/types.js";
import * as store from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../public");

const app = express();
app.use(express.static(publicDir));
const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketAuth>(http, {
  cors: { origin: false },
});

store.load();

const room = (id: string) => `ev:${id}`;
const broadcastList = () => io.emit("events:list", store.summaries());

function run<T>(cb: ((r: any) => void) | undefined, fn: () => T | undefined) {
  if (typeof cb !== "function") return;
  try {
    const data = fn();
    cb({ ok: true, data });
  } catch (e) {
    cb({ ok: false, error: e instanceof store.StoreError ? e.message : "Beklenmeyen hata" });
    if (!(e instanceof store.StoreError)) console.error(e);
  }
}

io.use((socket, next) => {
  const auth = socket.handshake.auth as Partial<SocketAuth>;
  const clientId = typeof auth.clientId === "string" ? auth.clientId.slice(0, 64) : "";
  const name = store.cleanName(auth.name);
  if (!clientId || !name) return next(new Error("auth"));
  socket.data = { clientId, name };
  next();
});

io.on("connection", (socket) => {
  const { clientId, name } = socket.data;
  socket.emit("me", { pid: store.pidOf(clientId) });
  socket.emit("events:list", store.summaries());

  socket.on("time:ping", (cb) => typeof cb === "function" && cb(Date.now()));

  socket.on("event:join", (p, cb) => {
    // Zamanı işleme girmeden ÖNCE al: sıralamanın tek otoritesi bu.
    const at = Date.now();
    run(cb, () => {
      const ev = store.join(String(p?.id), clientId, name, at);
      io.to(room(ev.id)).emit("event:update", ev);
      broadcastList();
      return { at };
    });
  });

  socket.on("event:leave", (p, cb) =>
    run(cb, () => {
      const ev = store.leave(String(p?.id), clientId);
      io.to(room(ev.id)).emit("event:update", ev);
      broadcastList();
      return undefined;
    }),
  );

  socket.on("event:confirm", (p, cb) =>
    run(cb, () => {
      const ev = store.setConfirmed(String(p?.id), clientId, p?.confirmed !== false);
      io.to(room(ev.id)).emit("event:update", ev);
      broadcastList();
      return undefined;
    }),
  );

  socket.on("event:create", (input, cb) =>
    run(cb, () => {
      const ev = store.create(input, clientId, name);
      broadcastList();
      return { id: ev.id };
    }),
  );

  socket.on("event:delete", (p, cb) =>
    run(cb, () => {
      const id = String(p?.id);
      store.remove(id, clientId);
      io.emit("event:deleted", { id });
      broadcastList();
      return undefined;
    }),
  );

  socket.on("event:watch", (p, cb) =>
    run(cb, () => {
      const ev = store.get(String(p?.id));
      socket.join(room(ev.id));
      return ev;
    }),
  );

  socket.on("event:unwatch", (p) => socket.leave(room(String(p?.id))));
});

setInterval(() => {
  const gone = store.sweep();
  if (gone.length) {
    gone.forEach((id) => io.emit("event:deleted", { id }));
    broadcastList();
  }
}, 5_000); // maç saati gelen eventler birkaç saniye içinde düşsün

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.saveNow();
    process.exit(0);
  });
}

http.listen(PORT, () => console.log(`🏐 http://localhost:${PORT}`));
