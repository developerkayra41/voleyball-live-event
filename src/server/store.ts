import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import type { CreateEventInput, EventSummary, VoteEvent } from "../shared/types.js";

const DATA_FILE = process.env.DATA_FILE ?? "data.json";
const MAX_PENDING_PER_CREATOR = 5;
const DAY = 24 * 60 * 60 * 1000;

/** Sunucuda tutulan hali: gerçek clientId'ler burada kalır, dışarı çıkmaz. */
interface StoredJoin {
  clientId: string;
  name: string;
  at: number;
  seq: number;
}
interface StoredEvent {
  id: string;
  title: string;
  location?: string;
  note?: string;
  openAt: number;
  matchAt: number;
  capacity: number;
  createdBy: string;
  creatorId: string;
  createdAt: number;
  confirmedAt?: number;
  joins: StoredJoin[];
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
  const { creatorId, joins, ...rest } = ev;
  return {
    ...rest,
    creatorPid: pidOf(creatorId),
    joins: joins.map(({ clientId, ...j }) => ({ ...j, pid: pidOf(clientId) })),
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
export function load() {
  if (!existsSync(DATA_FILE)) return;
  try {
    const raw = JSON.parse(readFileSync(DATA_FILE, "utf8")) as { seqCounter: number; events: StoredEvent[] };
    seqCounter = raw.seqCounter ?? 0;
    for (const ev of raw.events ?? []) {
      // Maç tarihi eklenmeden önce oluşturulmuş eventler: açılıştan 1 gün sonrası say
      if (!Number.isFinite(ev.matchAt)) ev.matchAt = ev.openAt + DAY;
      events.set(ev.id, ev);
    }
    console.log(`${events.size} event yüklendi (${DATA_FILE})`);
  } catch (e) {
    console.error("snapshot okunamadı:", e);
  }
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
    capacity,
    createdBy: creatorName,
    creatorId,
    createdAt: now,
    joins: [],
  };
  events.set(ev.id, ev);
  scheduleSave();
  return toPublic(ev);
}

export function remove(id: string, clientId: string) {
  const ev = mustGet(id);
  if (ev.creatorId !== clientId) throw new StoreError("Sadece oluşturan kişi silebilir");
  events.delete(id);
  scheduleSave();
}

export function join(id: string, clientId: string, name: string, at: number): VoteEvent {
  const ev = mustGet(id);
  if (at < ev.openAt) throw new StoreError("Henüz açılmadı");
  if (ev.confirmedAt) throw new StoreError("Kadro onaylandı, artık katılım kapalı");
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
  if (ev.confirmedAt) throw new StoreError("Kadro onaylandı, çıkmak için oylama sahibine yaz");
  const before = ev.joins.length;
  ev.joins = ev.joins.filter((j) => j.clientId !== clientId);
  if (ev.joins.length === before) throw new StoreError("Listede değilsin");
  scheduleSave();
  return toPublic(ev);
}

/** Oylama sahibi kadroyu onaylar (kontenjan dolu veya taşmışsa) ya da onayı geri alır. */
export function setConfirmed(id: string, clientId: string, confirmed: boolean): VoteEvent {
  const ev = mustGet(id);
  if (ev.creatorId !== clientId) throw new StoreError("Sadece oylama sahibi onaylayabilir");
  if (confirmed) {
    if (ev.joins.length < ev.capacity)
      throw new StoreError(`Kontenjan dolmadan onaylanamaz (${ev.joins.length}/${ev.capacity})`);
    ev.confirmedAt = Date.now();
  } else {
    delete ev.confirmedAt;
  }
  scheduleSave();
  return toPublic(ev);
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
