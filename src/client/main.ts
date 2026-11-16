import { io, type Socket } from "socket.io-client";
import type { ClientToServer, EventSummary, ServerToClient, VoteEvent } from "../shared/types";

type S = Socket<ServerToClient, ClientToServer>;

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);

// ---------- kimlik ----------
const LS_NAME = "vb.name";
const LS_ID = "vb.clientId";
function storageGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storageSet(k: string, v: string) {
  try { localStorage.setItem(k, v); } catch { /* yoksay */ }
}
let clientId = storageGet(LS_ID);
if (!clientId) {
  clientId = crypto.getRandomValues(new Uint32Array(4)).reduce((s, n) => s + n.toString(36), "");
  storageSet(LS_ID, clientId);
}
let myName = storageGet(LS_NAME) ?? "";

// ---------- saat senkronu ----------
let offset = 0; // serverNow - localNow
const serverNow = () => Date.now() + offset;

async function syncClock(sock: S, samples = 5) {
  let best = { rtt: Infinity, off: 0 };
  for (let i = 0; i < samples; i++) {
    const t0 = performance.now();
    const w0 = Date.now();
    const srv = await new Promise<number>((res) => sock.timeout(3000).emit("time:ping", (err: unknown, n: number) => res(err ? NaN : n)));
    const rtt = performance.now() - t0;
    if (!Number.isFinite(srv)) continue;
    const off = srv - (w0 + rtt / 2);
    if (rtt < best.rtt) best = { rtt, off };
  }
  if (Number.isFinite(best.rtt)) offset = best.off;
}

// ---------- format ----------
const pad = (n: number, l = 2) => String(n).padStart(l, "0");
function fmtClock(ms: number) {
  const d = new Date(ms);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}
function fmtCountdown(ms: number, tenths = true) {
  if (ms < 0) ms = 0;
  const days = Math.floor(ms / 86_400_000);
  const h = Math.floor((ms % 86_400_000) / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const t = Math.floor((ms % 1000) / 100);
  const base = `${pad(h)}:${pad(m)}:${pad(s)}`;
  if (days > 0) return `${days}g ${base}`;
  return tenths ? `${base}.${t}` : base;
}
const DAYS = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"];
function fmtWhen(ms: number) {
  const d = new Date(ms);
  const today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  const same = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  const day = same(d, today) ? "Bugün" : same(d, tomorrow) ? "Yarın"
    : `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${DAYS[d.getDay()]}`;
  const sec = d.getSeconds() ? `:${pad(d.getSeconds())}` : "";
  return `${day} ${pad(d.getHours())}:${pad(d.getMinutes())}${sec}`;
}

// ---------- toast ----------
let toastTimer = 0;
function toast(msg: string, kind: "ok" | "err" = "ok") {
  const t = $("toast");
  t.textContent = msg;
  t.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (t.className = "toast"), 2600);
}

// ---------- state ----------
let socket: S | null = null;
let list: EventSummary[] = [];
let current: VoteEvent | null = null;
/** Sunucudan gelen kendi public id'm (gerçek clientId hiç paylaşılmaz) */
let myPid = "";
/** Modaldaki event'in tam hali (katılımcı listesiyle) sunucudan geldi mi */
let loaded = false;
let joinPending = false;
const seen = new Set<string>();

/** Her karede çağrılan yerlerde DOM'u sadece değer değişince güncelle */
function setText(el: HTMLElement, v: string) {
  if (el.textContent !== v) el.textContent = v;
}
function setHTML(el: HTMLElement, v: string) {
  if (el.dataset.html !== v) {
    el.dataset.html = v;
    el.innerHTML = v;
  }
}

// ---------- login ----------
function showLogin() {
  $("login").hidden = false;
  $("app").hidden = true;
  const inp = $<HTMLInputElement>("login-name");
  inp.value = myName;
  setTimeout(() => inp.focus(), 50);
}
$("login-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const v = $<HTMLInputElement>("login-name").value.replace(/\s+/g, " ").trim().slice(0, 32);
  if (!v) return;
  myName = v;
  storageSet(LS_NAME, v);
  start();
});
$("change-name").addEventListener("click", () => {
  socket?.disconnect();
  socket = null;
  showLogin();
});

// ---------- bağlantı ----------
function start() {
  $("login").hidden = true;
  $("app").hidden = false;
  $("me-name").textContent = myName;
  socket?.disconnect();
  const s: S = io({ auth: { clientId, name: myName } });
  socket = s;

  s.on("connect", async () => {
    $("conn").classList.add("on");
    await syncClock(s);
    if (current) watch(current.id);
  });
  s.on("me", ({ pid }) => {
    myPid = pid;
    if (current) renderModal();
  });
  s.on("disconnect", () => $("conn").classList.remove("on"));
  s.on("connect_error", (err) => {
    $("conn").classList.remove("on");
    if (err.message === "auth") showLogin();
  });
  s.on("events:list", (l) => {
    list = l;
    renderList();
    focusFromUrl();
  });
  s.on("event:update", (ev) => {
    if (current?.id === ev.id) {
      // Biri çıktığı için yedekten kadroya geçtiysem haber ver
      const before = mySlot(current);
      current = ev;
      loaded = true;
      renderModal();
      const after = mySlot(ev);
      if (before === "bench" && after === "main") toast("🎉 Biri çıktı, kadroya girdin!");
    }
  });
  s.on("event:deleted", ({ id }) => {
    if (current?.id === id) {
      const started = serverNow() >= current.matchAt - 10_000;
      closeEvent();
      toast(started ? "Maç başladı, oylama kapandı" : "Bu oylama silindi", "err");
    }
  });
}
setInterval(() => socket?.connected && syncClock(socket, 3), 30_000);

// ---------- ana liste ----------
type Phase = "matches" | "live" | "upcoming" | "gone";
function phase(e: { openAt: number; matchAt: number; confirmedAt?: number }): Phase {
  const now = serverNow();
  if (now >= e.matchAt) return "gone"; // maç başladı, sunucu da birkaç sn içinde siler
  if (e.confirmedAt) return "matches";
  if (now < e.openAt) return "upcoming";
  return "live";
}
const isLocked = (e: { lockAt: number }) => serverNow() >= e.lockAt;
/** Faz ya da kilit durumu değişince liste yeniden çizilsin */
const listKey = () => list.map((e) => phase(e) + (isLocked(e) ? "L" : "")).join();
const hhmm = (ms: number) => { const d = new Date(ms); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

function cardHtml(e: EventSummary, ph: Phase) {
  const full = e.count >= e.capacity;
  const pct = Math.min(100, (e.count / e.capacity) * 100);
  const locked = isLocked(e);
  const badge =
    ph === "upcoming"
      ? `<span class="badge cd" data-cd="${e.openAt}">${fmtCountdown(e.openAt - serverNow(), false)}</span>`
      : ph === "matches"
        ? `<span class="badge ok">✓ ONAYLANDI</span>`
        : locked
          ? `<span class="badge">🔒 KAYIT KAPALI</span>`
          : `<span class="badge live">CANLI</span>`;
  const when =
    ph === "upcoming" ? `Açılış ${fmtWhen(e.openAt)}` : ph === "matches" ? `Maça <span data-cd="${e.matchAt}">${fmtCountdown(e.matchAt - serverNow(), false)}</span>` : "";
  return `<button class="ev-card ${ph}" data-id="${e.id}">
    <div class="ev-card-top">${badge}<span class="muted small">${ph === "upcoming" ? esc(when) : when}</span></div>
    <div class="ev-card-title">${esc(e.title)}</div>
    <div class="match-line small">🏐 Maç: <b>${esc(fmtWhen(e.matchAt))}</b></div>
    <div class="muted small">${locked ? "🔒 Kayıtlar kapandı" : `⏱ Kayıtlar ${hhmm(e.lockAt)}'da kapanır`}</div>
    ${e.location ? `<div class="muted small">📍 ${esc(e.location)}</div>` : ""}
    <div class="bar"><span style="width:${pct}%"></span></div>
    <div class="ev-card-foot small">
      <span><b class="${full ? "neon" : ""}">${e.count}</b>/${e.capacity}${e.count > e.capacity ? ` <span class="muted">+${e.count - e.capacity} yedek</span>` : ""}</span>
      <span class="muted">${esc(e.createdBy)}</span>
    </div>
  </button>`;
}

let lastPhases = "";
function renderList() {
  const groups: Record<Exclude<Phase, "gone">, EventSummary[]> = { matches: [], live: [], upcoming: [] };
  for (const e of list) {
    const ph = phase(e);
    if (ph !== "gone") groups[ph].push(e);
  }
  groups.matches.sort((a, b) => a.matchAt - b.matchAt);
  for (const k of Object.keys(groups) as (keyof typeof groups)[]) {
    $(`list-${k}`).innerHTML = groups[k].map((e) => cardHtml(e, k)).join("");
    $(`g-${k}`).hidden = groups[k].length === 0;
  }
  $("empty").hidden = Object.values(groups).some((g) => g.length > 0);
  lastPhases = listKey();
}

document.querySelector(".container")!.addEventListener("click", (e) => {
  const card = (e.target as HTMLElement).closest<HTMLElement>(".ev-card");
  if (card?.dataset.id) openEvent(card.dataset.id);
});

// liste geri sayımları
setInterval(() => {
  if ($("app").hidden) return;
  if (listKey() !== lastPhases) return renderList();
  document.querySelectorAll<HTMLElement>("[data-cd]").forEach((el) => {
    el.textContent = fmtCountdown(Number(el.dataset.cd) - serverNow(), false);
  });
}, 250);

// ---------- event modalı ----------
const evModal = $<HTMLDialogElement>("ev-modal");

function mySlot(ev: VoteEvent): "main" | "bench" | null {
  if (!myPid || !loaded) return null;
  const i = ev.joins.findIndex((j) => j.pid === myPid);
  return i < 0 ? null : i < ev.capacity ? "main" : "bench";
}

function watch(id: string) {
  socket?.emit("event:watch", { id }, (r) => {
    if (!r.ok) {
      toast(r.error, "err");
      closeEvent();
      return;
    }
    if (current?.id !== id) return; // bu arada başka event açıldı/kapandı
    current = r.data!;
    loaded = true;
    renderModal();
  });
}

function openEvent(id: string) {
  if (current && current.id !== id) socket?.emit("event:unwatch", { id: current.id });
  const sum = list.find((e) => e.id === id);
  // Tam veri gelene kadar özetle göster; liste ve buton "yükleniyor" durumunda kalır.
  current = { id, title: sum?.title ?? "", location: sum?.location, openAt: sum?.openAt ?? Infinity,
    matchAt: sum?.matchAt ?? Infinity, lockAt: sum?.lockAt ?? Infinity, confirmedAt: sum?.confirmedAt,
    capacity: sum?.capacity ?? 12, createdBy: sum?.createdBy ?? "", creatorPid: "", createdAt: 0, joins: [], log: [] };
  loaded = false;
  renderModal();
  if (!evModal.open) evModal.showModal();
  watch(id);
}

function closeEvent() {
  if (current) socket?.emit("event:unwatch", { id: current.id });
  current = null;
  loaded = false;
  if (evModal.open) evModal.close();
}
evModal.addEventListener("close", () => current && closeEvent());

/** Paylaşılan link (?e=<id>) modalı açmaz; sadece ilgili kartı vurgular. */
function focusFromUrl() {
  const url = new URL(location.href);
  const id = url.searchParams.get("e");
  if (!id) return;
  url.searchParams.delete("e");
  history.replaceState(null, "", url);
  const card = document.querySelector<HTMLElement>(`.ev-card[data-id="${CSS.escape(id)}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: "smooth", block: "center" });
  card.classList.add("focus");
  setTimeout(() => card.classList.remove("focus"), 2500);
}

function renderModal() {
  const ev = current;
  if (!ev) return;
  $("ev-title").textContent = ev.title;
  $("ev-match").textContent = Number.isFinite(ev.matchAt) ? `🏐 Maç: ${fmtWhen(ev.matchAt)}` : "";
  $("ev-modal").classList.toggle("confirmed", !!ev.confirmedAt);
  $("ev-meta").innerHTML = [
    ev.location ? `📍 ${esc(ev.location)}` : "",
    `👤 ${esc(ev.createdBy)}`,
  ].filter(Boolean).join(" · ");
  const note = $("ev-note");
  note.textContent = ev.note ?? "";
  note.hidden = !ev.note;
  $("ev-count").textContent = String(Math.min(ev.joins.length, ev.capacity));
  $("ev-cap").textContent = String(ev.capacity);
  $("ev-delete").hidden = !myPid || ev.creatorPid !== myPid;

  const roster = $("ev-roster");
  if (!loaded) {
    roster.innerHTML = `<li class="roster-empty muted">Yükleniyor…</li>`;
  } else if (!ev.joins.length) {
    roster.innerHTML = `<li class="roster-empty muted">Henüz kimse katılmadı</li>`;
  } else {
    roster.innerHTML = ev.joins
      .map((j, i) => {
        const bench = i >= ev.capacity;
        const sep = i === ev.capacity ? `<li class="sep"><span>yedekler</span></li>` : "";
        const delta = (j.at - ev.openAt) / 1000;
        const mine = j.pid === myPid;
        const fresh = !seen.has(ev.id + j.pid);
        seen.add(ev.id + j.pid);
        return `${sep}<li class="r ${bench ? "bench" : "main"} ${mine ? "me" : ""} ${fresh ? "new" : ""}">
          <span class="pos">${i + 1}</span>
          <span class="nm">${esc(j.name)}${mine ? ' <span class="you">sen</span>' : ""}${bench ? ' <span class="tag">YEDEK</span>' : ""}${!bench && j.promotedAt ? ` <span class="tag up" title="${esc(fmtClock(j.promotedAt))}">YEDEKTEN</span>` : ""}</span>
          <span class="tm"><span class="clk">${fmtClock(j.at)}</span><span class="dl">+${delta.toFixed(3)}s</span></span>
        </li>`;
      })
      .join("");
  }
  renderLog(ev);
  tickModal();
}

function renderLog(ev: VoteEvent) {
  const box = $("ev-log");
  const entries = loaded ? [...ev.log].reverse() : [];
  box.hidden = entries.length === 0;
  const afterConfirm = entries.filter((l) => l.afterConfirm);
  $("ev-log-sum").textContent = [
    `${entries.filter((l) => l.type === "promoted").length} yedekten giriş`,
    `${afterConfirm.filter((l) => l.type === "left").length} onay sonrası çıkış`,
  ].join(" · ");
  $("ev-log-list").innerHTML = entries
    .map((l) => {
      const text =
        l.type === "promoted"
          ? `<b>${esc(l.name)}</b> yedekten kadroya girdi <span class="muted">(#${l.pos}${l.replaced ? `, ${esc(l.replaced)} yerine` : ""})</span>`
          : `<b>${esc(l.name)}</b> ${l.wasMain ? "kadrodan" : "yedekten"} çıktı <span class="muted">(#${l.pos})</span>`;
      return `<li class="lg ${l.type}">
        <span class="ic">${l.type === "promoted" ? "↑" : "✕"}</span>
        <span class="tx">${text}${l.afterConfirm ? ' <span class="tag ac">ONAY SONRASI</span>' : ""}</span>
        <span class="tm">${fmtClock(l.at).slice(0, 8)}</span>
      </li>`;
    })
    .join("");
}

function tickModal() {
  const ev = current;
  if (!ev || !evModal.open) return;
  const now = serverNow();
  const left = ev.openAt - now;
  const confirmed = loaded && !!ev.confirmedAt;
  // Kayıt kapanış saatinden sonra katıl/vazgeç kapalı (onaydan bağımsız)
  const locked = loaded && now >= ev.lockAt;
  const open = loaded && left <= 0 && !locked;
  const full = ev.joins.length >= ev.capacity;
  const idx = myPid ? ev.joins.findIndex((j) => j.pid === myPid) : -1;
  const joined = idx >= 0;
  const bench = idx >= ev.capacity;
  const btn = $<HTMLButtonElement>("ev-join");
  const status = $("ev-status");
  const cd = $("ev-countdown");

  setText(cd, !loaded ? "--:--:--" : confirmed || locked ? fmtCountdown(ev.matchAt - now, false) : open ? "AÇIK" : fmtCountdown(left));
  cd.classList.toggle("open", open && !confirmed);
  cd.classList.toggle("ok", confirmed);
  cd.classList.toggle("soon", loaded && left > 0 && left < 10_000);
  // innerHTML her karede yazılırsa canlı noktanın animasyonu sürekli sıfırlanır
  setHTML(status,
    confirmed ? (locked ? "✓ Kadro onaylandı · 🔒 kayıtlar kapalı · maça kalan" : "✓ Kadro onaylandı · maça kalan")
    : locked ? "🔒 Kayıtlar kapandı · maça kalan"
    : open ? `<span class="live-dot"></span> CANLI` : "Açılmayı bekliyor");
  setText($("ev-opens"), !loaded ? ""
    : left > 0 ? `Oylama açılışı: ${fmtWhen(ev.openAt)} · kayıtlar ${hhmm(ev.lockAt)}'da kapanır`
    : locked ? `Kayıtlar ${hhmm(ev.lockAt)}'da kapandı · Maç ${hhmm(ev.matchAt)}`
    : `Kayıtların kapanmasına ${fmtCountdown(ev.lockAt - now, false)} (${hhmm(ev.lockAt)})`);
  status.classList.toggle("on", open && !confirmed);
  status.classList.toggle("ok", confirmed);

  btn.classList.toggle("ready", open && !joined);
  btn.classList.toggle("joined", open && joined);
  btn.classList.toggle("final", confirmed);
  btn.disabled = !open || joinPending || !myPid;
  const label = btn.querySelector<HTMLElement>(".label")!;
  const lock = btn.querySelector<HTMLElement>(".lock")!;
  lock.hidden = open;
  const hint = $("ev-hint");
  const reserveNo = idx - ev.capacity + 1;
  if (locked) {
    setText(label, "KAYITLAR KAPANDI");
    setHTML(hint, !joined ? "Giriş çıkış kapalı. Bu maça artık katılamazsın."
      : bench ? `Yedektesin: <b>${reserveNo}. sıra</b>. Giriş çıkış kapandı.`
      : `Kadrodasın: <b class="${confirmed ? "okc" : "neon"}">#${idx + 1}</b>. Giriş çıkış kapandı.`);
  } else if (joined) {
    setText(label, "VAZGEÇ");
    setHTML(hint, bench
      ? `Yedeksin: <b>${reserveNo}. sıradasın</b>. Kadrodan biri çıkarsa otomatik girersin.`
      : confirmed ? `Sahadasın! <b class="okc">#${idx + 1}</b>`
      : `Sıran: <b class="neon">#${idx + 1}</b> · ${fmtClock(ev.joins[idx].at)}`);
  } else {
    setText(label, open && full ? "YEDEĞE YAZIL" : "KATIL");
    setHTML(hint, !open ? "Saat gelince buton açılacak"
      : full ? "Kadro dolu. Yedeğe yazılırsan biri çıktığında sırayla kadroya girersin."
      : confirmed ? `Kadroda ${ev.capacity - ev.joins.length} boş yer var!`
      : "Hemen bas!");
  }

  // Oylama sahibine onay kutusu (oylama açıldıktan sonra)
  const isOwner = loaded && !!myPid && ev.creatorPid === myPid;
  const ownerBox = $("ev-owner");
  ownerBox.hidden = !isOwner || left > 0;
  if (!ownerBox.hidden) {
    const cBtn = $<HTMLButtonElement>("ev-confirm");
    const missing = ev.capacity - ev.joins.length;
    cBtn.classList.toggle("undo", confirmed);
    setText(cBtn, confirmed ? "Onayı geri al" : "✓ Kadroyu Onayla");
    cBtn.disabled = confirmPending || (!confirmed && missing > 0);
    setText($("ev-owner-text"), confirmed
      ? missing > 0 ? `Kadroyu onayladın ama şu an ${missing} kişi eksik (${ev.joins.length}/${ev.capacity}).`
        : "Kadroyu onayladın. Çıkan olursa yedekler sırayla kadroya girer."
      : missing > 0 ? `Onaylamak için ${missing} kişi daha gerekli (${ev.joins.length}/${ev.capacity})`
      : `Kontenjan doldu (${ev.joins.length}/${ev.capacity}). Kadroyu onaylayabilirsin.`);
  }
}

let confirmPending = false;
$("ev-confirm").addEventListener("click", () => {
  const ev = current;
  if (!ev || !socket || confirmPending) return;
  const confirmed = !ev.confirmedAt;
  if (!confirmed && !confirm("Onayı geri almak istediğine emin misin? Maç 'Oynanacak Maçlar'dan çıkar.")) return;
  confirmPending = true;
  socket.emit("event:confirm", { id: ev.id, confirmed }, (r) => {
    confirmPending = false;
    if (r.ok) toast(confirmed ? "Kadro onaylandı ✓" : "Onay geri alındı");
    else toast(r.error, "err");
  });
});
(function loop() {
  tickModal();
  requestAnimationFrame(loop);
})();

$("ev-join").addEventListener("click", () => {
  const ev = current;
  if (!ev || !socket || joinPending || !loaded || !myPid) return;
  const slot = mySlot(ev);
  const joined = slot !== null;
  const hasReserve = ev.joins.length > ev.capacity;
  const msg = slot === "main" && hasReserve
    ? `Kadrodan çıkmak istediğine emin misin? Yerine ilk yedek (${ev.joins[ev.capacity].name}) girecek. Tekrar katılırsan sona eklenirsin.`
    : "Listeden çıkmak istediğine emin misin? Tekrar katılırsan sona eklenirsin.";
  if (joined && !confirm(msg)) return;
  joinPending = true;
  const done = () => { joinPending = false; };
  if (joined) {
    socket.emit("event:leave", { id: ev.id }, (r) => {
      done();
      r.ok ? toast("Listeden çıktın") : toast(r.error, "err");
    });
  } else {
    socket.emit("event:join", { id: ev.id }, (r) => {
      done();
      if (r.ok) toast(`Kaydedildi · ${fmtClock(r.data!.at)}`);
      else toast(r.error, "err");
    });
  }
});

$("ev-share").addEventListener("click", async () => {
  if (!current) return;
  const url = `${location.origin}${location.pathname}?e=${current.id}`;
  try {
    await navigator.clipboard.writeText(url);
    toast("Link kopyalandı");
  } catch {
    prompt("Linki kopyala:", url);
  }
});

$("ev-delete").addEventListener("click", () => {
  if (!current || !confirm("Bu oylamayı silmek istediğine emin misin?")) return;
  socket?.emit("event:delete", { id: current.id }, (r) => {
    if (r.ok) { closeEvent(); toast("Silindi"); } else toast(r.error, "err");
  });
});

// ---------- oluşturma modalı ----------
const newModal = $<HTMLDialogElement>("new-modal");
const newForm = $<HTMLFormElement>("new-form");

function toLocalInput(ms: number) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

$("new-event").addEventListener("click", () => {
  newForm.reset();
  $("new-err").textContent = "";
  const d = new Date();
  d.setHours(21, 0, 0, 0);
  if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
  const openAtInput = newForm.elements.namedItem("openAt") as HTMLInputElement;
  // reset() "Hemen aç" kutusunu temizler ama inputun disabled halini geri almaz
  openAtInput.disabled = false;
  openAtInput.value = toLocalInput(d.getTime());
  // Varsayılan maç: oylamadan bir gün sonra 21:30
  const m = new Date(d);
  m.setDate(m.getDate() + 1);
  m.setHours(21, 30, 0, 0);
  (newForm.elements.namedItem("matchAt") as HTMLInputElement).value = toLocalInput(m.getTime()).slice(0, 16);
  updateLockPreview();
  newModal.showModal();
});

const nowBox = newForm.elements.namedItem("now") as HTMLInputElement;
nowBox.addEventListener("change", () => {
  (newForm.elements.namedItem("openAt") as HTMLInputElement).disabled = nowBox.checked;
});

/** Formda "kayıtlar şu saatte kapanacak" önizlemesi */
function lockHoursValue() {
  const v = Number((newForm.elements.namedItem("lockHours") as HTMLInputElement).value);
  return Number.isFinite(v) && v >= 0 ? v : 2;
}
function updateLockPreview() {
  const raw = (newForm.elements.namedItem("matchAt") as HTMLInputElement).value;
  const matchAt = raw ? new Date(raw).getTime() : NaN;
  $("lock-preview").textContent = Number.isFinite(matchAt)
    ? `Kayıtlar ${fmtWhen(matchAt - lockHoursValue() * 3_600_000)}'da kapanır. Sonra kimse katılamaz ve çıkamaz.`
    : "Bu saatten sonra kimse katılamaz ve çıkamaz.";
}
newForm.addEventListener("input", updateLockPreview);

newForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const f = new FormData(newForm);
  const now = nowBox.checked;
  const raw = String(f.get("openAt") ?? "");
  const openAt = now ? null : raw ? new Date(raw).getTime() : NaN;
  if (!now && !Number.isFinite(openAt)) {
    $("new-err").textContent = "Oylama açılış zamanı seç";
    return;
  }
  const rawMatch = String(f.get("matchAt") ?? "");
  const matchAt = rawMatch ? new Date(rawMatch).getTime() : NaN;
  if (!Number.isFinite(matchAt)) {
    $("new-err").textContent = "Maç tarihi ve saatini seç";
    return;
  }
  if (matchAt <= (openAt ?? Date.now())) {
    $("new-err").textContent = "Maç, oylama açıldıktan sonra olmalı";
    return;
  }
  const lockHours = lockHoursValue();
  if (matchAt - lockHours * 3_600_000 <= (openAt ?? Date.now())) {
    $("new-err").textContent = "Kayıtlar oylama açılmadan kapanmış olur; kapanış süresini kısalt";
    return;
  }
  socket?.emit(
    "event:create",
    {
      title: String(f.get("title") ?? ""),
      location: String(f.get("location") ?? ""),
      note: String(f.get("note") ?? ""),
      openAt,
      matchAt,
      lockHours,
      capacity: Number(f.get("capacity") ?? 12),
    },
    (r) => {
      if (!r.ok) {
        $("new-err").textContent = r.error;
        return;
      }
      newModal.close();
      openEvent(r.data!.id);
    },
  );
});

// ortak kapatma
document.querySelectorAll<HTMLElement>("[data-close]").forEach((b) =>
  b.addEventListener("click", () => (b.closest("dialog") as HTMLDialogElement).close()),
);
for (const d of [evModal, newModal]) {
  d.addEventListener("click", (e) => {
    if (e.target === d) d.close(); // arka plana tıklama
  });
}

// ---------- başlat ----------
if (myName) start();
else showLogin();
