import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { CreateEventInput, EventSummary, LogEntry, VoteEvent } from "../shared/types.js";

const DATA_FILE = process.env.DATA_FILE ?? "data.json";
const MAX_PENDING_PER_CREATOR = 5;
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const DEFAULT_LOCK_HOURS = 2;

const hhmm = (ms: number) =>
  new Date(ms).toLocaleTimeString("tr-TR", { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Istanbul" });

/** Sunucuda tutulan hali: gerçek clientId'ler burada kalır, dışarı çıkmaz. */
interface StoredJoin {
  clientId: string;
  name: string;
  at: number;
  seq: number;
  promotedAt?: number;
}
type StoredLog = Omit<LogEntry, "pid"> & { clientId: string };
const MAX_LOG = 200;
interface StoredEvent {
  id: string;
  title: string;
  location?: string;
  note?: string;
  openAt: number;
  matchAt: number;
  lockAt: number;
  capacity: number;
  createdBy: string;
  creatorId: string;
  createdAt: number;
  confirmedAt?: number;
  autoConfirmed?: boolean;
  joins: StoredJoin[];
  log: StoredLog[];
}

const events = new Map<string, StoredEvent>();
let seqCounter = 0;

export class StoreError extends Error {}

function newId(): string {
  return randomBytes(5).toString("base64url");
}

/** clientId'den geri döndürülemeyen public id */
export function pidOf(clientId: string): string {
  return createHash("sha256").update(clientId).digest("base64url").slice(0, 16);
}

function toPublic(ev: StoredEvent): VoteEvent {
  const { creatorId, joins, log, ...rest } = ev;
  return {
    ...rest,
    creatorPid: pidOf(creatorId),
    joins: joins.map(({ clientId, ...j }) => ({ ...j, pid: pidOf(clientId) })),
    log: log.map(({ clientId, ...l }) => ({ ...l, pid: pidOf(clientId) })),
  };
}

const clean = (s: unknown, max: number): string =>
  typeof s === "string" ? s.replace(/\s+/g, " ").trim().slice(0, max) : "";

export function cleanName(s: unknown): string {
  return clean(s, 32);
}

// ---------- snapshot ----------
let saveTimer: NodeJS.Timeout | null = null;
function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveNow();
  }, 500);
}
export function saveNow() {
  try {
    const tmp = DATA_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify({ seqCounter, events: [...events.values()] }));
    renameSync(tmp, DATA_FILE);
  } catch (e) {
    console.error("snapshot yazılamadı:", e);
  }
}
const isStr = (v: unknown): v is string => typeof v === "string" && v.length > 0;
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Dosyadan ya da içe aktarmadan gelen bir eventi doğrular ve eksik alanları tamamlar. */
function normalize(raw: unknown): StoredEvent | null {
  const ev = raw as Partial<StoredEvent> | null;
  if (!ev || !isStr(ev.id) || !isStr(ev.title) || !isNum(ev.openAt) || !isStr(ev.creatorId)) return null;
  // Maç tarihi eklenmeden önce oluşturulmuş eventler: açılıştan 1 gün sonrası say
  const matchAt = isNum(ev.matchAt) ? ev.matchAt : ev.openAt + DAY;
  const joins = (Array.isArray(ev.joins) ? ev.joins : []).filter(
    (j): j is StoredJoin => !!j && isStr(j.clientId) && isStr(j.name) && isNum(j.at) && isNum(j.seq),
  );
  const log = (Array.isArray(ev.log) ? ev.log : []).filter(
    (l): l is StoredLog => !!l && isStr(l.clientId) && isStr(l.name) && isNum(l.at) && (l.type === "left" || l.type === "promoted"),
  );
  return {
    id: ev.id,
    title: ev.title,
    location: typeof ev.location === "string" ? ev.location : undefined,
    note: typeof ev.note === "string" ? ev.note : undefined,
    openAt: ev.openAt,
    matchAt,
    lockAt: isNum(ev.lockAt) ? ev.lockAt : Math.max(ev.openAt, matchAt - DEFAULT_LOCK_HOURS * HOUR),
    capacity: isNum(ev.capacity) ? Math.min(100, Math.max(1, Math.floor(ev.capacity))) : 12,
    createdBy: typeof ev.createdBy === "string" ? ev.createdBy : "",
    creatorId: ev.creatorId,
    createdAt: isNum(ev.createdAt) ? ev.createdAt : ev.openAt,
    confirmedAt: isNum(ev.confirmedAt) ? ev.confirmedAt : undefined,
    autoConfirmed: ev.autoConfirmed === true ? true : undefined,
    joins: joins.sort((a, b) => a.at - b.at || a.seq - b.seq),
    log,
  };
}

export function load() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf8")) as { seqCounter?: number; events?: unknown[] };
    seqCounter = isNum(raw.seqCounter) ? raw.seqCounter : 0;
    for (const item of raw.events ?? []) {
      const ev = normalize(item);
      if (ev) events.set(ev.id, ev);
    }
    console.log(`${events.size} event yüklendi (${DATA_FILE})`);
  } catch (e) {
    console.error("snapshot okunamadı:", e);
  }
}

// ---------- yedekleme: dışa / içe aktarma ----------
export interface Backup {
  app: "voleybol-kadro";
  version: 1;
  exportedAt: string;
  seqCounter: number;
  events: StoredEvent[];
}

/** Tüm veriyi (gerçek kimlik anahtarlarıyla birlikte) yedek olarak döner. */
export function exportData(): Backup {
  return {
    app: "voleybol-kadro",
    version: 1,
    exportedAt: new Date().toISOString(),
    seqCounter,
    events: [...events.values()],
  };
}

/**
 * Yedeği geri yükler. Mevcut tüm eventler yedektekilerle DEĞİŞTİRİLİR.
 * Maç saati geçmiş eventler alınmaz. Etkilenen (eklenen/silinen) id'leri döner.
 */
export function importData(raw: unknown): { imported: number; skipped: number; removed: string[]; ids: string[] } {
  const data = raw as Partial<Backup> | null;
  if (!data || !Array.isArray(data.events)) throw new StoreError("Geçersiz yedek dosyası: 'events' listesi yok");
  const now = Date.now();
  const next = new Map<string, StoredEvent>();
  let skipped = 0;
  for (const item of data.events) {
    const ev = normalize(item);
    if (!ev || now >= ev.matchAt) {
      skipped++;
      continue;
    }
    next.set(ev.id, ev);
  }
  const removed = [...events.keys()].filter((id) => !next.has(id));
  events.clear();
  for (const [id, ev] of next) events.set(id, ev);
  // Yeni katılımlar yedektekilerden sonra sıralansın
  const maxSeq = Math.max(0, ...[...next.values()].flatMap((e) => e.joins.map((j) => j.seq)));
  seqCounter = Math.max(seqCounter, isNum(data.seqCounter) ? data.seqCounter : 0, maxSeq);
  scheduleSave();
  return { imported: next.size, skipped, removed, ids: [...next.keys()] };
}

// ---------- queries ----------
function mustGet(id: string): StoredEvent {
  const ev = events.get(id);
  if (!ev || Date.now() >= ev.matchAt) throw new StoreError("Event bulunamadı");
  return ev;
}

export function get(id: string): VoteEvent {
  return toPublic(mustGet(id));
}

export function summaries(): EventSummary[] {
  const now = Date.now();
  return [...events.values()]
    .filter((e) => now < e.matchAt)
    .sort((a, b) => a.openAt - b.openAt)
    .map((e) => ({
      id: e.id,
      title: e.title,
      location: e.location,
      openAt: e.openAt,
      matchAt: e.matchAt,
      lockAt: e.lockAt,
      capacity: e.capacity,
      createdBy: e.createdBy,
      confirmedAt: e.confirmedAt,
      count: e.joins.length,
    }));
}

// ---------- mutations ----------
export function create(input: CreateEventInput, creatorId: string, creatorName: string): VoteEvent {
  const title = clean(input?.title, 120);
  if (!title) throw new StoreError("Başlık gerekli");
  const now = Date.now();
  let openAt = input.openAt == null ? now : Number(input.openAt);
  const matchAt = Number(input.matchAt);
  if (!Number.isFinite(openAt)) throw new StoreError("Geçersiz açılış zamanı");
  if (!Number.isFinite(matchAt)) throw new StoreError("Maç tarihi ve saati gerekli");
  if (openAt < now - 60_000) throw new StoreError("Açılış zamanı geçmişte olamaz");
  if (openAt < now) openAt = now;
  if (matchAt > now + 60 * DAY) throw new StoreError("Maç en fazla 60 gün sonrası olabilir");
  if (matchAt <= openAt) throw new StoreError("Maç tarihi oylamanın açılışından sonra olmalı");
  const rawLock = Number(input.lockHours);
  const lockHours = Number.isFinite(rawLock) ? Math.min(72, Math.max(0, rawLock)) : DEFAULT_LOCK_HOURS;
  const lockAt = matchAt - lockHours * HOUR;
  if (lockAt <= openAt)
    throw new StoreError("Kayıtlar oylama açılmadan kapanmış olur; kapanış süresini kısalt ya da oylamayı daha erken aç");
  const pending = [...events.values()].filter((e) => e.creatorId === creatorId && e.openAt > now).length;
  if (pending >= MAX_PENDING_PER_CREATOR)
    throw new StoreError(`Aynı anda en fazla ${MAX_PENDING_PER_CREATOR} bekleyen oylama açabilirsin`);
  const capacity = Math.min(100, Math.max(1, Math.floor(Number(input.capacity) || 12)));
  const ev: StoredEvent = {
    id: newId(),
    title,
    location: clean(input.location, 120) || undefined,
    note: clean(input.note, 400) || undefined,
    openAt,
    matchAt,
    lockAt,
    capacity,
    createdBy: creatorName,
    creatorId,
    createdAt: now,
    joins: [],
    log: [],
  };
  events.set(ev.id, ev);
  scheduleSave();
  return toPublic(ev);
}

export function remove(id: string, clientId: string, asAdmin = false) {
  const ev = mustGet(id);
  if (!asAdmin && ev.creatorId !== clientId) throw new StoreError("Sadece oluşturan kişi silebilir");
  events.delete(id);
  scheduleSave();
}

/** Tüm oylamaları siler (sadece admin çağırır); silinen id'leri döner */
export function removeAll(): string[] {
  const ids = [...events.keys()];
  events.clear();
  scheduleSave();
  return ids;
}

export function join(id: string, clientId: string, name: string, at: number): VoteEvent {
  const ev = mustGet(id);
  if (at < ev.openAt) throw new StoreError("Henüz açılmadı");
  if (at >= ev.lockAt) throw new StoreError(`Kayıtlar ${hhmm(ev.lockAt)}'da kapandı, artık giriş yapılamaz`);
  // Onaydan sonra da katılım açık: kontenjan doluysa yeni gelen yedeğe yazılır.
  if (!name) throw new StoreError("İsim gerekli");
  if (ev.joins.some((j) => j.clientId === clientId)) throw new StoreError("Zaten katıldın");
  const lower = name.toLocaleLowerCase("tr");
  if (ev.joins.some((j) => j.name.toLocaleLowerCase("tr") === lower))
    throw new StoreError("Bu isimle katılan biri var, ismini farklılaştır");
  ev.joins.push({ clientId, name, at, seq: ++seqCounter });
  ev.joins.sort((a, b) => a.at - b.at || a.seq - b.seq);
  scheduleSave();
  return toPublic(ev);
}

export function leave(id: string, clientId: string): VoteEvent {
  const ev = mustGet(id);
  // Onaydan sonra da çıkılabilir; sıralama korunduğu için ilk yedek otomatik kadroya girer.
  const idx = ev.joins.findIndex((j) => j.clientId === clientId);
  if (idx < 0) throw new StoreError("Listede değilsin");
  const now = Date.now();
  if (now >= ev.lockAt) throw new StoreError(`Kayıtlar ${hhmm(ev.lockAt)}'da kapandı, artık çıkış yapılamaz`);
  const afterConfirm = !!ev.confirmedAt;
  const leaving = ev.joins[idx];
  const mainBefore = new Set(ev.joins.slice(0, ev.capacity).map((j) => j.clientId));
  ev.joins.splice(idx, 1);

  const wasMain = idx < ev.capacity;
  ev.log.push({ type: "left", clientId, name: leaving.name, at: now, afterConfirm, pos: idx + 1, wasMain });
  // Kadroya yeni giren (yedekten yükselen) kişileri bul ve kaydet
  ev.joins.slice(0, ev.capacity).forEach((j, i) => {
    if (mainBefore.has(j.clientId)) return;
    j.promotedAt = now;
    ev.log.push({ type: "promoted", clientId: j.clientId, name: j.name, at: now, afterConfirm, pos: i + 1, replaced: leaving.name });
  });
  if (ev.log.length > MAX_LOG) ev.log.splice(0, ev.log.length - MAX_LOG);
  scheduleSave();
  return toPublic(ev);
}

/** Oylama sahibi kadroyu onaylar (kontenjan dolu veya taşmışsa) ya da onayı geri alır. */
export function setConfirmed(id: string, clientId: string, confirmed: boolean): VoteEvent {
  const ev = mustGet(id);
  if (ev.creatorId !== clientId) throw new StoreError("Sadece oylama sahibi onaylayabilir");
  if (Date.now() >= ev.lockAt) throw new StoreError("Kayıtlar kapandığı için kadro otomatik kesinleşti, değiştirilemez");
  if (confirmed) {
    if (ev.joins.length < ev.capacity)
      throw new StoreError(`Kontenjan dolmadan onaylanamaz (${ev.joins.length}/${ev.capacity})`);
    ev.confirmedAt = Date.now();
    ev.autoConfirmed = false;
  } else {
    delete ev.confirmedAt;
    delete ev.autoConfirmed;
  }
  scheduleSave();
  return toPublic(ev);
}

/**
 * Kayıt saati gelmiş ama onaylanmamış oylamaları otomatik onaylar.
 * Kontenjan dolmasa bile o anki kadro kesinleşir. Onaylanan id'leri döner.
 */
export function autoConfirm(): string[] {
  const now = Date.now();
  const done: string[] = [];
  for (const [id, ev] of events) {
    if (!ev.confirmedAt && now >= ev.lockAt && now < ev.matchAt) {
      ev.confirmedAt = ev.lockAt;
      ev.autoConfirmed = true;
      done.push(id);
    }
  }
  if (done.length) scheduleSave();
  return done;
}

/** Maç saati gelmiş eventleri siler; silinen id'leri döner */
export function sweep(): string[] {
  const now = Date.now();
  const gone: string[] = [];
  for (const [id, ev] of events) {
    if (now >= ev.matchAt) {
      events.delete(id);
      gone.push(id);
    }
  }
  if (gone.length) scheduleSave();
  return gone;
}
