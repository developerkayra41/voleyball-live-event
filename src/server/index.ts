import "./env.js"; // .env'yi diğer her şeyden önce yükle
import express from "express";
import { createServer } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { Server } from "socket.io";
import type { ClientToServer, ServerToClient, SocketAuth, SocketData } from "../shared/types.js";
import * as store from "./store.js";

const PORT = Number(process.env.PORT ?? 3000);
const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(here, "../../public");

const app = express();
app.use(express.static(publicDir));
const http = createServer(app);
const io = new Server<ClientToServer, ServerToClient, Record<string, never>, SocketData>(http, {
  cors: { origin: false },
});

store.load();

const room = (id: string) => `ev:${id}`;
const broadcastList = () => io.emit("events:list", store.summaries());

// ---------- yönetim: yedeği dışa / içe aktarma ----------
// ADMIN_KEY ortam değişkeni tanımlı değilse bu adresler tamamen kapalıdır.
const ADMIN_KEY = process.env.ADMIN_KEY ?? "";
/** Verilen anahtar ADMIN_KEY ile aynı mı (sabit zamanlı karşılaştırma) */
function keyMatches(key: unknown): boolean {
  if (typeof key !== "string" || ADMIN_KEY.length < 8) return false;
  const given = Buffer.from(key);
  const want = Buffer.from(ADMIN_KEY);
  return given.length === want.length && timingSafeEqual(given, want);
}
function isAdmin(req: express.Request): boolean {
  // Anahtar ?key=... parametresiyle ya da x-admin-key başlığıyla gelebilir
  const fromQuery = typeof req.query.key === "string" ? req.query.key : "";
  return keyMatches(fromQuery || String(req.get("x-admin-key") ?? ""));
}
const adminOnly: express.RequestHandler = (req, res, next) => {
  if (!ADMIN_KEY) return void res.status(404).json({ error: "Yönetim kapalı: sunucuda ADMIN_KEY tanımlı değil" });
  if (!isAdmin(req)) return void res.status(401).json({ error: "Anahtar yanlış" });
  next();
};

app.get("/api/export", adminOnly, (_req, res) => {
  // Dosya adında Türkiye saati: voleybol-yedek-2026-11-16-21-05.json
  const stamp = new Date()
    .toLocaleString("sv-SE", { timeZone: "Europe/Istanbul", hour12: false })
    .slice(0, 16)
    .replace(/[: ]/g, "-");
  res.setHeader("Content-Disposition", `attachment; filename="voleybol-yedek-${stamp}.json"`);
  res.setHeader("Cache-Control", "no-store");
  res.json(store.exportData());
});

app.post("/api/import", adminOnly, express.json({ limit: "5mb" }), (req, res) => {
  try {
    const result = store.importData(req.body);
    // Açık pencereleri ve ana sayfaları güncelle
    result.removed.forEach((id) => io.emit("event:deleted", { id }));
    result.ids.forEach((id) => io.to(room(id)).emit("event:update", store.get(id)));
    broadcastList();
    console.log(`yedek içe aktarıldı: ${result.imported} event, ${result.skipped} atlandı`);
    res.json({ imported: result.imported, skipped: result.skipped, removed: result.removed.length });
  } catch (e) {
    res.status(400).json({ error: e instanceof store.StoreError ? e.message : "İçe aktarılamadı" });
  }
});

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
  const triedAdmin = typeof auth.adminKey === "string" && auth.adminKey.length > 0;
  const isAdmin = triedAdmin && keyMatches(auth.adminKey);
  socket.data = { clientId, name, isAdmin, adminRejected: triedAdmin && !isAdmin };
  next();
});

io.on("connection", (socket) => {
  const { clientId, name, isAdmin, adminRejected } = socket.data;
  socket.emit("me", { pid: store.pidOf(clientId), admin: isAdmin, adminRejected });
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
      store.remove(id, clientId, isAdmin); // admin herkesin oylamasını silebilir
      if (isAdmin) console.log(`admin oylama sildi: ${id}`);
      io.emit("event:deleted", { id });
      broadcastList();
      return undefined;
    }),
  );

  socket.on("admin:deleteAll", (cb) =>
    run(cb, () => {
      if (!isAdmin) throw new store.StoreError("Bu işlem için yetkin yok");
      const ids = store.removeAll();
      console.log(`admin tüm oylamaları sildi: ${ids.length}`);
      ids.forEach((id) => io.emit("event:deleted", { id }));
      broadcastList();
      return { count: ids.length };
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
  gone.forEach((id) => io.emit("event:deleted", { id }));
  // Kayıt saati gelenler otomatik onaylanır
  const confirmed = store.autoConfirm();
  confirmed.forEach((id) => io.to(room(id)).emit("event:update", store.get(id)));
  if (gone.length || confirmed.length) broadcastList();
}, 1_000); // kayıt kapanışı ve maç saati birkaç saniye içinde işlensin

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    store.saveNow();
    process.exit(0);
  });
}

http.listen(PORT, () => {
  console.log(`🏐 http://localhost:${PORT}`);
  console.log(ADMIN_KEY ? "🔑 yedekleme açık: /admin.html" : "🔒 yedekleme kapalı (ADMIN_KEY tanımlı değil)");
  if (ADMIN_KEY && ADMIN_KEY.length < 8) console.warn("⚠ ADMIN_KEY en az 8 karakter olmalı, şu an çalışmaz");
});
