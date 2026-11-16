/**
 * İstemciye giden tipler. Gerçek clientId hiçbir zaman gönderilmez:
 * clientId kimlik yerine geçtiği için sızarsa başkası onun adına
 * "vazgeç" diyebilir ya da eventi silebilir. Onun yerine tek yönlü
 * hash'ten türetilen `pid` (public id) gönderilir.
 */
export interface Join {
  pid: string;
  name: string;
  /** Sunucu zamanı (epoch ms), tek otorite */
  at: number;
  /** Aynı ms içinde gelenler için sıra */
  seq: number;
}

export interface VoteEvent {
  id: string;
  title: string;
  location?: string;
  note?: string;
  openAt: number;
  /** Maç tarihi+saati (epoch ms). Bu an gelince event otomatik silinir. */
  matchAt: number;
  capacity: number;
  createdBy: string;
  creatorPid: string;
  createdAt: number;
  /** Oylama sahibi kadroyu onayladıysa zamanı */
  confirmedAt?: number;
  joins: Join[];
}

export interface EventSummary {
  id: string;
  title: string;
  location?: string;
  openAt: number;
  matchAt: number;
  capacity: number;
  createdBy: string;
  confirmedAt?: number;
  count: number;
}

export interface CreateEventInput {
  title: string;
  location?: string;
  note?: string;
  /** null => hemen aç */
  openAt: number | null;
  matchAt: number;
  capacity: number;
}

export type Ack<T = undefined> = (res: { ok: true; data?: T } | { ok: false; error: string }) => void;

export interface ClientToServer {
  "time:ping": (cb: (serverNow: number) => void) => void;
  "event:create": (input: CreateEventInput, cb: Ack<{ id: string }>) => void;
  "event:delete": (p: { id: string }, cb: Ack) => void;
  "event:watch": (p: { id: string }, cb: Ack<VoteEvent>) => void;
  "event:unwatch": (p: { id: string }) => void;
  "event:join": (p: { id: string }, cb: Ack<{ at: number }>) => void;
  "event:leave": (p: { id: string }, cb: Ack) => void;
  "event:confirm": (p: { id: string; confirmed: boolean }, cb: Ack) => void;
}

export interface ServerToClient {
  /** Bağlanınca kişinin kendi public id'si */
  me: (p: { pid: string }) => void;
  "events:list": (list: EventSummary[]) => void;
  "event:update": (ev: VoteEvent) => void;
  "event:deleted": (p: { id: string }) => void;
}

export interface SocketAuth {
  clientId: string;
  name: string;
}
