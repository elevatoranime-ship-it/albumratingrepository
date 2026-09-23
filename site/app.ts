/* ==========================================================================
   Пространство · альбомы и оценки
   Оценки ставятся НА ТРЕКИ; балл альбома = среднее арифметическое оценок
   его треков. Данные: Supabase (облако) или localStorage (демо).
   ========================================================================== */

import { canEvaluate, sameEvaluators, requiredEvaluators, allRatingsConfirmed } from './rating-access';

import { createClient, type SupabaseClient, type RealtimeChannel } from '@supabase/supabase-js';

/* ---------- Конфигурация (config.js) ---------- */
interface AllowedUser { email: string; username: string; initials: string; admin?: boolean; }
interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  allowedUsers: AllowedUser[];
  demoPassword?: string;
}

const DEFAULT_USERS: AllowedUser[] = [
  { email: 'killmiplag@demo.local', username: 'киллмиплаг', initials: 'к', admin: false },
  { email: 'elevator@demo.local', username: 'Elevator', initials: 'E', admin: true },
];

const cfg = (window as unknown as { APP_CONFIG?: AppConfig }).APP_CONFIG;
const DEMO = new URLSearchParams(window.location.search).get('demo') === '1';
const CLOUD = !DEMO && Boolean(cfg && cfg.supabaseUrl && cfg.supabaseAnonKey);
const ALLOWED_USERS: AllowedUser[] =
  !DEMO && cfg && cfg.allowedUsers && cfg.allowedUsers.length ? cfg.allowedUsers : DEFAULT_USERS;
const DEMO_PASSWORD = DEMO ? 'demo' : cfg?.demoPassword ?? 'demo';

/* ---------- Supabase ---------- */
let sb: SupabaseClient | null = null;
function getSB(): SupabaseClient {
  if (!sb) sb = createClient(cfg!.supabaseUrl, cfg!.supabaseAnonKey);
  return sb;
}

/* ---------- Типы ---------- */
interface ProfileInfo { id: string; email: string; username: string; initials: string; avatarUrl: string | null; }
/** Тип релиза: полноценный альбом или сингл (один трек, оценка ставится релизу целиком). */
type ReleaseKind = 'album' | 'single';
interface UiAlbum {
  evaluatorId?: string | null; // null — все участники; иначе единственный оценивающий
  id: string; artist: string; title: string; year: number; cover: string;
  kind: ReleaseKind;            // 'album' | 'single'
  parentId: string | null;      // первый альбом, совместимость со старыми данными
  parentIds?: string[];         // все альбомы сингла в порядке выбора
  tracksLocked: boolean;
  cohesion: number | null;      // целостность/концептуальность: 1..5, финально (только альбомы)
  geniusId?: string | null;     // ID песни Genius с текстом (у синглов)
  albumType: string | null;     // 'album' | 'ep' | 'compilation', финально (только альбомы)
}
interface UiTrack { id: string; albumId: string; title: string; position: number; locked: boolean; featArtist: string | null; singleId: string | null; geniusId: string | null; }
interface TrackRating { score: number; confirmed: boolean; }
type RatingMap = Record<string, Record<string, TrackRating>>;
interface PendingRating { value: TrackRating | null; savedAfterRead?: number; failed?: boolean; }
interface AddInput {
  evaluatorId?: string | null;
  artist: string; title: string; year: number;
  coverDataUrl: string | null;
  coverUrl: string | null;
  kind?: ReleaseKind;        // по умолчанию — альбом
  parentIds?: string[];      // альбомы сингла
}

/* ---------- Демо-сид (локальный режим) ---------- */
const SEED_ALBUMS: UiAlbum[] = [
  { id: 'music', title: 'MUSIC', artist: 'Playboi Carti', year: 2025, cover: 'covers/music.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'music-demo', title: 'MUSIC — демо-издание', artist: 'Playboi Carti', year: 2025, cover: 'covers/music.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'afterlyfe', title: 'AftërLyfe', artist: 'Yeat', year: 2023, cover: 'covers/afterlyfe.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'chromakopia', title: 'CHROMAKOPIA', artist: 'Tyler, The Creator', year: 2024, cover: 'covers/chromakopia.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'gnx', title: 'GNX', artist: 'Kendrick Lamar', year: 2024, cover: 'covers/gnx.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'hurry-up-tomorrow', title: 'Hurry Up Tomorrow', artist: 'The Weeknd', year: 2025, cover: 'covers/hurry-up-tomorrow.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'blonde', title: 'Blonde', artist: 'Frank Ocean', year: 2016, cover: 'covers/blonde.jpg', kind: 'album', parentId: null, tracksLocked: false, cohesion: null, albumType: 'album' },
];

/* синглы: один самостоятельный (со своей обложкой) и три, привязанных к альбомам */
const SEED_SINGLES: UiAlbum[] = [
  { id: 's-nikes', title: 'Nikes', artist: 'Frank Ocean', year: 2016, cover: '', kind: 'single', parentId: 'blonde', tracksLocked: false, cohesion: null, albumType: null },
  { id: 's-timeless', title: 'Timeless & Playboi Carti', artist: 'The Weeknd', year: 2024, cover: '', kind: 'single', parentId: 'hurry-up-tomorrow', tracksLocked: false, cohesion: null, albumType: null },
  { id: 's-mojo-jojo', title: 'MOJO JOJO', artist: 'Playboi Carti', year: 2025, cover: '', kind: 'single', parentId: 'music', parentIds: ['music', 'music-demo'], tracksLocked: false, cohesion: null, albumType: null },
  { id: 's-not-like-us', title: 'Not Like Us', artist: 'Kendrick Lamar', year: 2024, cover: 'covers/not-like-us.jpg', kind: 'single', parentId: null, tracksLocked: false, cohesion: null, albumType: null },
];

/* демо-треки: чтобы в демо-режиме было видно связку «трек с меткой сингла ↔ сам сингл»,
   трек «Nikes» сразу привязан к синглу s-nikes (одинаковая оценка на альбоме и на сингле) */
const SEED_TRACKS: UiTrack[] = [
  { id: 'mojo-music', albumId: 'music', title: 'MOJO JOJO', position: 0, locked: false, featArtist: null, singleId: 's-mojo-jojo', geniusId: null },
  { id: 'mojo-demo', albumId: 'music-demo', title: 'MOJO JOJO', position: 0, locked: false, featArtist: null, singleId: 's-mojo-jojo', geniusId: null },
  { id: 'nike-track', albumId: 'blonde', title: 'Nikes', position: 0, locked: false, featArtist: null, singleId: 's-nikes', geniusId: null },
];

/* демо-оценки синглов: подтверждённые участвуют в рейтинге, неподтверждённые — нет */
const SEED_SINGLE_RATINGS: RatingMap = {
  's-nikes': {
    'killmiplag@demo.local': { score: 9.4, confirmed: true },
    'elevator@demo.local': { score: 8.6, confirmed: true },
  },
  's-not-like-us': {
    'killmiplag@demo.local': { score: 9.6, confirmed: true },
    'elevator@demo.local': { score: 9.8, confirmed: true },
  },
  's-timeless': {
    'killmiplag@demo.local': { score: 7.2, confirmed: true },
    'elevator@demo.local': { score: 8.0, confirmed: false },
  },
};

/* ---------- Состояние ---------- */
let currentUser: ProfileInfo | null = null;
let albums: UiAlbum[] = [];       // и альбомы, и синглы (различаются полем kind)
let tracks: UiTrack[] = [];
let trackRatings: RatingMap = {}; // trackId -> profileId -> {score, confirmed}
let singleRatings: RatingMap = {}; // singleId -> profileId -> {score, confirmed}
/* Синглы требуют обновлённой схемы базы (albums.kind, single_ratings).
   Если таблицы ещё нет, раздел синглов аккуратно сообщает об этом. */
let singlesReady = true;
let currentAlbumId: string | null = null;
let currentSingleId: string | null = null;
let currentArtistName: string | null = null;
let homeMode: ReleaseKind = 'album'; // что показывает главная: альбомы или синглы
/* стек навигации: история переходов, верхний элемент — текущий экран */
type ViewEntry =
  | { view: 'home' }
  | { view: 'album'; albumId: string }
  | { view: 'single'; singleId: string }
  | { view: 'artist' }
  | { view: 'profile' }
  | { view: 'rank' }
  | { view: 'arank' }
  | { view: 'trank' }
  | { view: 'add'; kind: ReleaseKind };
const viewStack: ViewEntry[] = [{ view: 'home' }];
const profileCache = new Map<string, { username: string; initials: string; avatarUrl: string | null }>(); // profileId -> подпись + аватар

/* ---------- Локальное хранилище (демо) ---------- */
const LS_KEY = 'albums_local_v1';         // и альбомы, и синглы
const LS_TRACKS = 'tracks_local_v1';
const LS_RATINGS = 'track_ratings_local_v1';
const LS_SINGLE_RATINGS = 'single_ratings_local_v1';
const LS_META = 'profile_meta_local_v1'; // { email: { username, avatarUrl } } — правки ника/аватара в демо
const LS_HOME_MODE = 'home_mode_local_v1'; // какой раздел главной открыт: albums | singles

type LocalMeta = Record<string, { username: string; avatarUrl: string | null }>;
function loadLocalMeta(): LocalMeta {
  try {
    const raw = localStorage.getItem(LS_META);
    if (raw) return JSON.parse(raw) as LocalMeta;
  } catch { /* ignore */ }
  return {};
}
function saveLocalMeta(m: LocalMeta): void {
  try { localStorage.setItem(LS_META, JSON.stringify(m)); } catch { /* ignore */ }
}

/** Приводит запись из хранилища или базы к актуальному виду (старые данные — без kind). */
function normalizeAlbum(a: Partial<UiAlbum> & { id: string; artist: string; title: string; year: number }): UiAlbum {
  return {
    id: a.id,
    artist: a.artist,
    title: a.title,
    year: a.year,
    cover: a.cover ?? '',
    evaluatorId: a.evaluatorId ?? null,
    kind: a.kind === 'single' ? 'single' : 'album',
    parentId: a.parentIds?.[0] ?? (a.parentIds ? null : a.parentId ?? null),
    ...(a.kind === 'single' ? { parentIds: [...new Set(a.parentIds ?? (a.parentId ? [a.parentId] : []))] } : {}),
    tracksLocked: Boolean(a.tracksLocked),
    cohesion: a.cohesion ?? null,
    albumType: a.albumType ?? null,
  };
}

function loadLocalAlbums(): UiAlbum[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as UiAlbum[];
      if (Array.isArray(parsed)) return parsed.map((a) => normalizeAlbum(a));
    }
  } catch { /* ignore */ }
  return [...SEED_ALBUMS, ...SEED_SINGLES].map((a) => ({ ...a }));
}

function loadLocalTracks(): UiTrack[] {
  try {
    const raw = localStorage.getItem(LS_TRACKS);
    if (raw) {
      const parsed = JSON.parse(raw) as UiTrack[];
      if (Array.isArray(parsed)) {
        return parsed.map((t) => ({
          ...t,
          locked: Boolean(t.locked),
          featArtist: t.featArtist ?? null,
          geniusId: (t as { geniusId?: string | null }).geniusId ?? null,
          singleId: t.singleId ?? null,
        }));
      }
    }
  } catch { /* ignore */ }
  return SEED_TRACKS.map((t) => ({ ...t }));
}

function parseRatingRows(parsed: Record<string, Record<string, number | TrackRating>>): RatingMap {
  const out: RatingMap = {};
  for (const [rid, map] of Object.entries(parsed)) {
    out[rid] = {};
    for (const [pid, v] of Object.entries(map)) {
      out[rid][pid] = typeof v === 'number'
        ? { score: v, confirmed: false }
        : { score: v.score, confirmed: Boolean(v.confirmed) };
    }
  }
  return out;
}

function loadLocalRatings(): RatingMap {
  try {
    const raw = localStorage.getItem(LS_RATINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Record<string, number | TrackRating>>;
      return parseRatingRows(parsed);
    }
  } catch { /* ignore */ }
  return {};
}

function loadLocalSingleRatings(): RatingMap {
  try {
    const raw = localStorage.getItem(LS_SINGLE_RATINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Record<string, number | TrackRating>>;
      return parseRatingRows(parsed);
    }
  } catch { /* ignore */ }
  return parseRatingRows(SEED_SINGLE_RATINGS as unknown as Record<string, Record<string, number | TrackRating>>);
}

function loadHomeMode(): ReleaseKind {
  try {
    return localStorage.getItem(LS_HOME_MODE) === 'single' ? 'single' : 'album';
  } catch { return 'album'; }
}

function saveHomeMode(): void {
  try { localStorage.setItem(LS_HOME_MODE, homeMode); } catch { /* ignore */ }
}

function saveLocalAlbums(): void {
  try { localStorage.setItem(LS_KEY, JSON.stringify(albums)); } catch { /* ignore */ }
}
function saveLocalTracks(): void {
  try { localStorage.setItem(LS_TRACKS, JSON.stringify(tracks)); } catch { /* ignore */ }
}
function saveLocalRatings(): void {
  try { localStorage.setItem(LS_RATINGS, JSON.stringify(trackRatings)); } catch { /* ignore */ }
}
function saveLocalSingleRatings(): void {
  try { localStorage.setItem(LS_SINGLE_RATINGS, JSON.stringify(singleRatings)); } catch { /* ignore */ }
}

/* ---------- Данные ---------- */
let dataReadRevision = 0;
const pendingRatings = new Map<string, PendingRating>();        // треки
const pendingSingleRatings = new Map<string, PendingRating>();  // синглы

/** Накладывает несохранённые локальные правки на прочитанные данные. */
function mergePending(incoming: RatingMap, pendingMap: Map<string, PendingRating>, readRevision: number): RatingMap {
  const myId = currentUser?.id;
  if (!myId) return incoming;
  for (const [releaseId, pending] of pendingMap) {
    // Ответ запроса, начатого до завершения записи, ещё может содержать старый балл.
    if (pending.savedAfterRead !== undefined && readRevision > pending.savedAfterRead) {
      pendingMap.delete(releaseId);
      continue;
    }
    if (pending.value) (incoming[releaseId] ??= {})[myId] = { ...pending.value };
    else if (incoming[releaseId]) {
      delete incoming[releaseId][myId];
      if (!Object.keys(incoming[releaseId]).length) delete incoming[releaseId];
    }
  }
  return incoming;
}

async function refreshData(signal?: AbortSignal): Promise<void> {
  const revision = ++dataReadRevision;
  const userId = currentUser?.id;
  if (CLOUD) {
    const s = getSB();
    const [pa, aa, ta, ra, sa] = await Promise.all([
      s.from('profiles').select('id, username, initials, avatar_url'),
      s.from('albums').select('*').order('created_at', { ascending: true }),
      s.from('tracks').select('*'),
      s.from('ratings').select('*'),
      s.from('single_ratings').select('*'),
    ].map((query) => signal ? query.abortSignal(signal) : query));
    if (revision !== dataReadRevision || userId !== currentUser?.id) return;
    if (pa.error) throw pa.error;
    if (aa.error) throw aa.error;
    if (ta.error) throw ta.error;
    if (ra.error) throw ra.error;
    // Таблицы single_ratings может ещё не быть (не выполнен migrate.sql):
    // тогда раздел синглов аккуратно сообщает об этом, а альбомы работают как раньше.
    singlesReady = !sa.error;

    profileCache.clear();
    for (const p of (pa.data ?? []) as Array<{ id: string; username: string; initials: string; avatar_url: string | null }>) {
      profileCache.set(p.id, { username: p.username, initials: p.initials, avatarUrl: p.avatar_url ?? null });
    }
    if (currentUser) {
      const me = profileCache.get(currentUser.id);
      if (me) currentUser.username = me.username, currentUser.avatarUrl = me.avatarUrl;
    }

    albums = ((aa.data ?? []) as Array<{ id: string; artist: string; title: string; year: number; cover_url: string | null; tracks_locked: boolean | null; cohesion: number | null; album_type: string | null; kind: string | null; parent_album_id: string | null; parent_album_ids?: string[] | null; genius_song_id?: number | null; evaluator_id?: string | null }>)
      .map((x) => normalizeAlbum({
        id: x.id, artist: x.artist, title: x.title, year: x.year, cover: x.cover_url ?? '', geniusId: x.genius_song_id != null ? String(x.genius_song_id) : null,
        kind: x.kind === 'single' ? 'single' : 'album',
        evaluatorId: x.evaluator_id ?? null,
        parentId: x.parent_album_id ?? null,
        parentIds: x.parent_album_ids ?? undefined,
        tracksLocked: Boolean(x.tracks_locked), cohesion: x.cohesion ?? null, albumType: x.album_type ?? null,
      }));

    tracks = ((ta.data ?? []) as Array<{ id: string; album_id: string; title: string; position: number; locked: boolean | null; feat_artist: string | null; single_id?: string | null; genius_song_id?: number | null }>)
      .map((t) => ({ id: t.id, albumId: t.album_id, title: t.title, position: t.position, locked: Boolean(t.locked), featArtist: t.feat_artist ?? null, singleId: t.single_id ?? null, geniusId: t.genius_song_id != null ? String(t.genius_song_id) : null }));

    const incoming: RatingMap = {};
    for (const r of (ra.data ?? []) as Array<{ track_id: string; profile_id: string; score: number; confirmed: boolean | null }>) {
      (incoming[r.track_id] ??= {})[r.profile_id] = { score: Number(r.score), confirmed: Boolean(r.confirmed) };
    }
    trackRatings = mergePending(incoming, pendingRatings, revision);

    const incomingSingles: RatingMap = {};
    for (const r of (sa.data ?? []) as Array<{ album_id: string; profile_id: string; score: number; confirmed: boolean | null }>) {
      (incomingSingles[r.album_id] ??= {})[r.profile_id] = { score: Number(r.score), confirmed: Boolean(r.confirmed) };
    }
    singleRatings = singlesReady ? mergePending(incomingSingles, pendingSingleRatings, revision) : {};
    shareRatingsWithSingles();
  } else {
    profileCache.clear();
    const meta = loadLocalMeta();
    ALLOWED_USERS.forEach((u) => {
      const m = meta[u.email.toLowerCase()];
      profileCache.set(u.email, {
        username: m?.username ?? u.username,
        initials: u.initials,
        avatarUrl: m?.avatarUrl ?? null,
      });
    });
    if (currentUser) {
      const me = profileCache.get(currentUser.id);
      if (me) currentUser.username = me.username, currentUser.avatarUrl = me.avatarUrl;
    }
    albums = loadLocalAlbums();
    tracks = loadLocalTracks();
    trackRatings = mergePending(loadLocalRatings(), pendingRatings, revision);
    singleRatings = mergePending(loadLocalSingleRatings(), pendingSingleRatings, revision);
    shareRatingsWithSingles();
    saveLocalRatings();
    saveLocalSingleRatings();
    singlesReady = true;
  }
}

/* Realtime — быстрый сигнал; периодическая сверка подхватывает пропущенные события. */
const SYNC_INTERVAL_MS = 5000;
let realtimeChannel: RealtimeChannel | null = null;
let syncActive = false;
let syncEpoch = 0;
let syncTimer: number | undefined;
let syncInterval: number | undefined;
let syncQueued = false;
let syncRenderPending = false;
let syncInFlight = false;
let syncController: AbortController | null = null;
let tracksRenderDeferred = false;
let finalizeRenderDeferred = false;

function canSync(): boolean {
  return syncActive && Boolean(currentUser) && document.visibilityState !== 'hidden' && navigator.onLine;
}

function requestSync(delay = 100): void {
  if (!syncActive || !currentUser) return;
  syncQueued = true;
  if (!canSync() || syncInFlight) return;
  if (syncTimer !== undefined) {
    if (delay !== 0) return;
    window.clearTimeout(syncTimer);
  }
  syncTimer = window.setTimeout(() => {
    syncTimer = undefined;
    void synchronizeData();
  }, delay);
}

function subscribeRealtime(): void {
  if (syncActive || !currentUser) return;
  syncActive = true;
  const epoch = ++syncEpoch;
  if (CLOUD) {
    realtimeChannel = getSB().channel('db-changes')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'albums' }, () => requestSync())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'tracks' }, () => requestSync())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, () => requestSync())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'single_ratings' }, () => requestSync())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => requestSync())
      .subscribe((status) => {
        if (epoch !== syncEpoch) return;
        if (status === 'SUBSCRIBED' || status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          requestSync(0); // в том числе после переподключения, а не только после нового события
        }
      });
  }
  syncInterval = window.setInterval(() => requestSync(), SYNC_INTERVAL_MS);
}

function stopRealtime(): void {
  syncActive = false;
  syncEpoch += 1;
  dataReadRevision += 1;
  window.clearInterval(syncInterval);
  window.clearTimeout(syncTimer);
  syncTimer = syncInterval = undefined;
  syncController?.abort();
  syncController = null;
  syncQueued = syncInFlight = syncRenderPending = false;
  tracksRenderDeferred = finalizeRenderDeferred = false;
  for (const timer of saveTimers.values()) window.clearTimeout(timer);
  saveTimers.clear();
  singleSaveTimers.clear();
  pendingRatings.clear();
  pendingSingleRatings.clear();
  ratingWrites.clear();
  singleWrites.clear();
  ratingPointerTrackId = null;
  singlePointerActive = false;
  activeTrackId = null;
  if (realtimeChannel) {
    const channel = realtimeChannel;
    realtimeChannel = null;
    void getSB().removeChannel(channel);
  }
}

async function synchronizeData(): Promise<void> {
  if (!canSync() || syncInFlight) return;
  const epoch = syncEpoch;
  syncInFlight = true;
  syncQueued = false;
  const before = JSON.stringify([albums, tracks, trackRatings, singleRatings, [...profileCache]]);
  const beforeAlbums = JSON.stringify(albums);
  const beforeTracks = JSON.stringify(tracks);
  const controller = new AbortController();
  syncController = controller;
  const timeout = window.setTimeout(() => controller.abort(), 10000);
  try {
    await refreshData(controller.signal);
    if (epoch !== syncEpoch) return;
    if (beforeAlbums !== JSON.stringify(albums)) finalizeRenderDeferred = true;
    if (beforeTracks !== JSON.stringify(tracks) || beforeAlbums !== JSON.stringify(albums)) tracksRenderDeferred = true;
    const changed = before !== JSON.stringify([albums, tracks, trackRatings, singleRatings, [...profileCache]]);
    syncRenderPending ||= changed;
    flushSynchronizedRender();
  } catch {
    // Оставляем показанные данные, следующая сверка или online/focus повторит запрос.
  } finally {
    window.clearTimeout(timeout);
    if (epoch === syncEpoch) {
      syncController = null;
      syncInFlight = false;
      if (syncQueued) requestSync(0); // событие, пришедшее во время чтения, не теряется
    }
  }
}

function flushSynchronizedRender(): void {
  if (!canSync() || (!syncRenderPending && !tracksRenderDeferred && !finalizeRenderDeferred)) return;
  renderSynchronizedData(syncRenderPending);
  // При переходе отрисуем также новый экран, когда закончится его появление.
  syncRenderPending = Boolean(document.querySelector('.view.is-leaving'));
}

function flushDeferredTrackRender(): void {
  if (!tracksRenderDeferred || !viewAlbum.classList.contains('is-visible')) return;
  if (ratingPointerTrackId || trackList.contains(document.activeElement) || trackList.querySelector('.dragging')) return;
  renderTracks();
}

function renderSynchronizedData(changed: boolean): void {
  if (changed) {
    homeTitle.textContent = currentUser?.username ?? 'Гость';
    setAvatarEl(homeAvatar, currentUser);
    if (viewHome.classList.contains('is-visible')) renderAlbums(false);
    if (viewArtist.classList.contains('is-visible')) renderArtistPage();
    if (viewRank.classList.contains('is-visible')) renderArtistRank();
    if (viewArank.classList.contains('is-visible')) renderAlbumRank();
    if (viewSrank.classList.contains('is-visible')) renderSingleRank();
    if (viewTrank.classList.contains('is-visible')) renderTrackRank();
    if (viewAlbum.classList.contains('is-visible')) renderAlbumSingles();
    // ссылка на страницу сингла могла исчезнуть (сингл удалён из другой вкладки)
    if (viewSingle.classList.contains('is-visible') && !currentSingle()) {
      viewStack.length = 0;
      viewStack.push({ view: 'home' });
      void swapTo(viewSingle, viewHome, () => { viewHome.scrollTop = 0; });
      renderAlbums();
      toast('Этот сингл удалён');
    }
  }
  if (viewSingle.classList.contains('is-visible')) {
    const s = currentSingle();
    if (s) {
      renderEvaluator(s, '#sv-evaluator');
      if (svTitle.textContent !== singleDisplayTitle(s)) svTitle.textContent = singleDisplayTitle(s);
      const artistHtml = singleArtistHTML(s, 'sv__artist-link');
      if (svArtist.innerHTML !== artistHtml) svArtist.innerHTML = artistHtml;
      if (svYear.textContent !== String(s.year)) svYear.textContent = String(s.year);
      if (svCoverImg.getAttribute('src') !== coverSrc(s)) {
        maybePlayCoverFresh(svCoverImg, coverSrc(s)); // до смены src: сравниваем со старой
        renderSingleCover(s);
      }
      renderSingleParents(s);
      const origin = singleOriginText(s);
      svOrigin.hidden = !origin;
      svOrigin.textContent = origin;
      updateSingleDisplays();
    }
  }
  if (viewAlbum.classList.contains('is-visible')) {
    const al = currentAlbum();
    if (al) {
      renderEvaluator(al, '#av-evaluator');
      avTitle.textContent = al.title;
      if (avArtist.querySelector<HTMLElement>('[data-artist]')?.dataset.artist !== al.artist) {
        avArtist.innerHTML = `<a class="av__artist-link" data-artist="${esc(al.artist)}">${esc(al.artist)}</a>`;
      }
      avYear.textContent = String(al.year);
      if (avCoverImg.getAttribute('src') !== coverSrc(al)) {
        maybePlayCoverFresh(avCoverImg, coverSrc(al)); // до смены src: сравниваем со старой
        renderAlbumCover(al);
      }
      if (finalizeRenderDeferred && !document.querySelector('.fin-select.is-open')) {
        renderFinalize();
        finalizeRenderDeferred = false;
      }
    }
    flushDeferredTrackRender();
    syncTrackRatingControls();
    updateRatingDisplays();
  }
}

function resumeSynchronization(): void {
  if (!canSync()) return;
  flushSynchronizedRender();
  for (const [trackId, pending] of pendingRatings) {
    if (pending.failed) void persistTrackRating(trackId).catch(() => {});
  }
  for (const [singleId, pending] of pendingSingleRatings) {
    if (pending.failed) void persistSingleRating(singleId).catch(() => {});
  }
  requestSync(0);
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    window.clearTimeout(syncTimer);
    syncTimer = undefined;
    syncController?.abort();
  } else resumeSynchronization();
});
window.addEventListener('focus', resumeSynchronization);
window.addEventListener('online', resumeSynchronization);
window.addEventListener('storage', (event) => {
  if (!CLOUD && (!event.key || [LS_KEY, LS_TRACKS, LS_RATINGS, LS_SINGLE_RATINGS, LS_META].includes(event.key))) requestSync(0);
});

/* ---------- Авторизация ---------- */
async function ensureProfile(user: { id: string; email?: string | null }): Promise<ProfileInfo> {
  const s = getSB();
  const { data } = await s.from('profiles').select('*').eq('id', user.id).maybeSingle();
  if (data) {
    return {
      id: data.id as string,
      email: user.email ?? '',
      username: data.username as string,
      initials: data.initials as string,
      avatarUrl: (data.avatar_url as string | null) ?? null,
    };
  }
  const email = (user.email ?? '').toLowerCase();
  const allowed = ALLOWED_USERS.find((u) => u.email.toLowerCase() === email);
  const username = allowed?.username ?? (user.email ?? 'user').split('@')[0];
  const initials = allowed?.initials ?? (username.charAt(0).toUpperCase() || '?');
  await s.from('profiles').insert({ id: user.id, username, initials, avatar_url: null });
  return { id: user.id, email: user.email ?? '', username, initials, avatarUrl: null };
}

async function loginCloud(email: string, password: string): Promise<void> {
  const { data, error } = await getSB().auth.signInWithPassword({ email, password });
  if (error) throw error;
  currentUser = await ensureProfile(data.user);
}

async function registerCloud(email: string, password: string): Promise<void> {
  const allowed = ALLOWED_USERS.find((u) => u.email.toLowerCase() === email.toLowerCase());
  if (!allowed) throw new Error('Доступ только для участников');
  const { data, error } = await getSB().auth.signUp({ email, password });
  if (error) throw error;
  if (data.session) {
    currentUser = await ensureProfile(data.user!);
    return;
  }
  throw new Error('Проверьте почту для подтверждения, затем войдите');
}

async function loginLocal(email: string, password: string): Promise<void> {
  const u = ALLOWED_USERS.find((x) => x.email.toLowerCase() === email.toLowerCase());
  if (!u || password !== DEMO_PASSWORD) throw new Error('Неверная почта или пароль');
  const m = loadLocalMeta()[u.email.toLowerCase()];
  currentUser = {
    id: u.email || 'p0',
    email: u.email,
    username: m?.username ?? u.username,
    initials: u.initials,
    avatarUrl: m?.avatarUrl ?? null,
  };
}

function isAdmin(): boolean {
  if (!currentUser) return false;
  return ALLOWED_USERS.find((u) => u.email.toLowerCase() === currentUser!.email.toLowerCase())?.admin === true;
}

function messageOf(err: unknown): string {
  const msg = (err as { message?: string } | null)?.message ?? String(err);
  if (/Invalid login credentials/i.test(msg)) return 'Неверная почта или пароль';
  if (/already registered/i.test(msg)) return 'Этот адрес уже зарегистрирован';
  if (/password should be at least/i.test(msg)) return 'Пароль слишком короткий (минимум 6 символов)';
  if (/Доступ только/i.test(msg)) return msg;
  if (/final/i.test(msg)) return 'Этот выбор уже зафиксирован';
  if (msg && msg !== 'Error') return msg;
  return 'Что-то пошло не так';
}

/* ---------- Утилиты ---------- */
const esc = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ---------- Аватары ---------- */
interface AvatarInfo { username: string; initials: string; avatarUrl?: string | null; }

const avatarStyle = (url: string): string =>
  `background-image:url('${url.replace(/'/g, '%27')}');background-size:cover;background-position:center`;

/* кружок-аватар: картинка, если есть, иначе первая буква */
function avatarMarkup(info: AvatarInfo, cls: string): string {
  if (info.avatarUrl) return `<span class="${cls}" style="${avatarStyle(info.avatarUrl)}"></span>`;
  return `<span class="${cls}">${esc(info.initials)}</span>`;
}

/* DOM-элемент-аватар (шапка, страница профиля) */
function setAvatarEl(el: HTMLElement, info: AvatarInfo | null): void {
  el.style.backgroundImage = '';
  el.textContent = '';
  if (!info) return;
  if (info.avatarUrl) el.setAttribute('style', avatarStyle(info.avatarUrl));
  else el.textContent = info.initials;
}

/** Число с максимум 2 знаками после запятой, без хвостовых нулей. */
const fmt = (n: number): string => String(parseFloat(n.toFixed(2)));

const round2 = (n: number): number => Math.round(n * 100) / 100;

/* --- финальные выборы альбома --- */
const COHESION_OPTIONS = [
  'Максимально целостный и кропотливый',
  'Достаточно целостный в рамках звукового содержания, текстового наполнения и хронологии прослушивания',
  'Концептуальность по каким-то отдельным аспектам: жанр, текст или задумка',
  'Не концептуальный, однако не является микстейпом',
  'Микстейп',
];
const TYPE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'album', label: 'Альбом' },
  { value: 'ep', label: 'EP' },
  { value: 'compilation', label: 'Сборник' },
];
function typeLabelOf(v: string | null): string {
  return TYPE_OPTIONS.find((o) => o.value === v)?.label ?? '';
}

const meanOf = (vals: number[]): number | null =>
  vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;

function trackScoreOf(trackId: string): number | null {
  const r = trackRatings[trackId];
  if (!r) return null;
  return meanOf(Object.values(r).map((x) => x.score));
}

/* --- релизы: альбомы и синглы живут в одном массиве --- */
const releasesOf = (kind: ReleaseKind): UiAlbum[] => albums.filter((a) => a.kind === kind);
const albumsOnly = (): UiAlbum[] => releasesOf('album');
const singlesOnly = (): UiAlbum[] => releasesOf('single');
const singleById = (id: string): UiAlbum | undefined =>
  albums.find((a) => a.id === id && a.kind === 'single');
const parentIdsOf = (a: UiAlbum): string[] => a.parentIds ?? (a.parentId ? [a.parentId] : []);
const parentsOf = (a: UiAlbum): UiAlbum[] => parentIdsOf(a)
  .map((id) => albums.find((x) => x.id === id && x.kind === 'album'))
  .filter((x): x is UiAlbum => Boolean(x));
const parentOf = (a: UiAlbum): UiAlbum | undefined => parentsOf(a)[0];

/* --- средние баллы --- */
function albumScoreOf(albumId: string): number | null {
  const vals: number[] = [];
  for (const t of tracks) {
    if (t.albumId !== albumId) continue;
    const r = trackRatings[t.id];
    if (r) for (const v of Object.values(r)) vals.push(v.score);
  }
  return meanOf(vals);
}

function singleScoreOf(singleId: string): number | null {
  const r = singleRatings[singleId];
  if (!r) return null;
  return meanOf(Object.values(r).map((x) => x.score));
}

/* --- «подтверждённые» средние: только они попадают в рейтинги --- */
function albumConfirmedScoreOf(albumId: string): number | null {
  const vals: number[] = [];
  for (const t of tracks) {
    if (t.albumId !== albumId) continue;
    const r = trackRatings[t.id];
    if (r) for (const v of Object.values(r)) if (v.confirmed) vals.push(v.score);
  }
  return meanOf(vals);
}

function singleConfirmedScoreOf(singleId: string): number | null {
  const r = singleRatings[singleId];
  if (!r) return null;
  return meanOf(Object.values(r).filter((v) => v.confirmed).map((v) => v.score));
}

/** Балл сингла для рейтинга: пока оценки подтверждены не всеми участниками,
    средний балл релиза считается неподтверждённым и в рейтинг не попадает. */
function singleRankedScoreOf(singleId: string): number | null {
  return singleAllConfirmed(singleId) ? singleScoreOf(singleId) : null;
}

/** Подсказка в рейтинге для сингла, который в него пока не попал. */
function singleRankReason(singleId: string): string {
  return singleVotesOf(singleId) === 0 ? 'оценок пока нет' : 'ждём подтверждения всех оценок';
}

/* сколько оценок ждут подтверждения (для подсказок и «пустых» состояний) */
function pendingCountOf(singleId: string): number {
  const r = singleRatings[singleId];
  if (!r) return 0;
  return Object.values(r).filter((v) => !v.confirmed).length;
}

function singleVotesOf(singleId: string): number {
  const r = singleRatings[singleId];
  return r ? Object.keys(r).length : 0;
}

/* подтверждённая оценка «товарища» на треке */
function peerRatingOf(trackId: string): { score: number; confirmed: boolean; username: string; initials: string; avatarUrl: string | null } | null {
  if (!currentUser) return null;
  const r = trackRatings[trackId];
  if (!r) return null;
  for (const [pid, v] of Object.entries(r)) {
    if (pid === currentUser.id) continue;
    const info = profileCache.get(pid);
    return { score: v.score, confirmed: v.confirmed, username: info?.username ?? 'участник', initials: info?.initials ?? '?', avatarUrl: info?.avatarUrl ?? null };
  }
  return null;
}

/* Все требуемые оценки подтверждены — релиз целиком «зафиксирован». */
function singleAllConfirmed(singleId: string): boolean {
  const release = singleById(singleId);
  return Boolean(release && allRatingsConfirmed(release, profileCache.keys(), [singleRatings[singleId]]));
}

/* Для персонального альбома достаточно подтверждения всех треков назначенным участником. */
function albumAllConfirmed(albumId: string): boolean {
  const release = albums.find((a) => a.id === albumId);
  return Boolean(release && allRatingsConfirmed(release, profileCache.keys(),
    tracks.filter((t) => t.albumId === albumId).map((t) => trackRatings[t.id])));
}

function trackRelease(trackId: string): UiAlbum | undefined {
  const track = tracks.find((t) => t.id === trackId);
  return albums.find((a) => a.id === track?.albumId);
}
function canRateTrack(trackId: string): boolean {
  return canEvaluate(trackRelease(trackId), currentUser?.id);
}
function renderEvaluator(release: UiAlbum, selector: string): void {
  const el = q<HTMLElement>(selector);
  el.hidden = !release.evaluatorId;
  const name = profileCache.get(release.evaluatorId ?? '')?.username ?? 'назначенный участник';
  el.textContent = `Оценивает только ${name}. ` + (canEvaluate(release, currentUser?.id)
    ? 'Вашей полной подтверждённой оценки достаточно для рейтинга.'
    : 'Вам доступны просмотр оценок и обычное редактирование, но не оценивание и выбор целостности.');
}
function assertCompatibleParents(release: { evaluatorId?: string | null }, ids: string[]): void {
  for (const id of ids) {
    const parent = albums.find((a) => a.id === id && a.kind === 'album');
    if (!parent || !sameEvaluators(release, parent)) {
      throw new Error(`У сингла и альбома «${parent?.title ?? id}» должны совпадать оценивающие участники`);
    }
  }
}

function trackCountOf(albumId: string): number {
  return tracks.filter((t) => t.albumId === albumId).length;
}

function plural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'альбом';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'альбома';
  return 'альбомов';
}

function tracksPlural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'трек';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'трека';
  return 'треков';
}

function featPlural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'фит';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'фита';
  return 'фитов';
}

/* «сингл / сингла / синглов» */
function singlesPlural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'сингл';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'сингла';
  return 'синглов';
}

/* «оценка / оценки / оценок» */
function votesPlural(n: number): string {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return 'оценка';
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return 'оценки';
  return 'оценок';
}

/* Плитка-заглушка: круг и первая буква названия релиза (или имени артиста). */
function letterCover(text: string): string {
  const initial = (text.trim().charAt(0) || '?').toUpperCase();
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>" +
    "<rect width='600' height='600' fill='#15151a'/>" +
    "<circle cx='300' cy='300' r='210' fill='none' stroke='rgba(183,168,239,0.16)' stroke-width='1.5'/>" +
    "<text x='300' y='345' font-family='Georgia, serif' font-size='210' fill='rgba(243,241,236,0.8)' text-anchor='middle'>" +
    esc(initial) +
    '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* «к альбому»: обложка сингла берётся у связанного альбома, пока своя не задана */
function coverSrc(a: UiAlbum): string {
  if (a.cover) return a.cover;
  if (a.kind === 'single') {
    const p = parentOf(a);
    if (p && p.cover) return p.cover;
  }
  return letterCover(a.title);
}

/* Есть ли у релиза настоящая картинка: своя обложка или обложка альбома сингла. */
function hasCoverArt(a: UiAlbum): boolean {
  return Boolean(a.cover || (a.kind === 'single' && parentOf(a)?.cover));
}

/* --- фиты и профили артистов --- */
const FEAT_RE = /(\bfeat\b\.?|\bft\b\.?|&)/i;

function featNameOf(title: string): string | null {
  const m = FEAT_RE.exec(title);
  if (!m) return null;
  const after = title.slice((m.index ?? 0) + m[0].length).trim();
  return after || null;
}

/* --- фит в названии сингла: название остаётся чистым, гостя показываем в блоке артиста --- */
interface SingleTitleInfo { title: string; featArtist: string | null; featAmp: boolean; }

/**
 * «Название & Гость» / «Название (feat. Гость)» / «Название ft. Гость»
 * → чистое название + имя гостя. Запись («&» или «feat.») сохраняется для блока артиста.
 */
function singleTitleInfo(a: UiAlbum): SingleTitleInfo {
  const raw = a.title.trim();
  const m = FEAT_RE.exec(raw);
  if (!m) return { title: raw, featArtist: null, featAmp: false };
  const title = raw.slice(0, m.index ?? 0).replace(/[\s([]+$/, '').trim();
  const featArtist = raw.slice((m.index ?? 0) + m[0].length).replace(/[),.\s]+$/, '').trim();
  if (!title || !featArtist) return { title: raw, featArtist: null, featAmp: false };
  return { title, featArtist, featAmp: m[0] === '&' };
}

/** Название сингла без фита — для заголовков, карточек и рейтинга. */
function singleDisplayTitle(a: UiAlbum): string {
  return a.kind === 'single' ? singleTitleInfo(a).title : a.title;
}

/** Дополнение к артисту сингла: « & Гость» или « (feat. Гость)»; «ft.» показываем как «feat.». */
function singleFeatSuffix(a: UiAlbum): string {
  if (a.kind !== 'single') return '';
  const info = singleTitleInfo(a);
  if (!info.featArtist) return '';
  return info.featAmp ? ` & ${info.featArtist}` : ` (feat. ${info.featArtist})`;
}

/** Артист сингла одним текстом: «Артист», «Артист & Гость» или «Артист (feat. Гость)». */
function singleArtistText(a: UiAlbum): string {
  return `${a.artist}${singleFeatSuffix(a)}`;
}

/** Блок артиста сингла: основной исполнитель и гость — ссылки на профили. */
function singleArtistHTML(a: UiAlbum, linkClass: string): string {
  const main = `<a class="${linkClass}" data-artist="${esc(a.artist)}">${esc(a.artist)}</a>`;
  if (a.kind !== 'single') return main;
  const info = singleTitleInfo(a);
  if (!info.featArtist) return main;
  const guest = `<a class="${linkClass}" data-artist="${esc(info.featArtist)}">${esc(info.featArtist)}</a>`;
  return info.featAmp
    ? `${main} &amp; ${guest}`
    : `${main} (feat. ${guest})`;
}

/** «Артист (feat. Гость) — Название» для подписей и диалогов. */
function releaseFullName(a: UiAlbum): string {
  return `${singleArtistText(a)} — ${singleDisplayTitle(a)}`;
}

/* все артисты: основные из альбомов и синглов + фиты из треков и названий синглов */
function allArtistNames(): string[] {
  const map = new Map<string, string>();
  for (const a of albums) {
    const n = a.artist.trim();
    if (n && !map.has(n.toLowerCase())) map.set(n.toLowerCase(), n);
  }
  for (const t of tracks) {
    const n = (t.featArtist ?? '').trim();
    if (n && !map.has(n.toLowerCase())) map.set(n.toLowerCase(), n);
  }
  for (const s of singlesOnly()) {
    const n = (featNameOf(s.title) ?? '').replace(/[),.\s]+$/, '').trim();
    if (n && !map.has(n.toLowerCase())) map.set(n.toLowerCase(), n);
  }
  return [...map.values()].sort((a, b) => a.localeCompare(b, 'ru'));
}

function canonicalArtistName(raw: string): string {
  const lower = raw.trim().toLowerCase();
  const existing = allArtistNames().find((n) => n.toLowerCase() === lower);
  return existing ?? raw.trim();
}

/* альбомы, где артист — основной исполнитель */
function artistOwnAlbums(name: string): UiAlbum[] {
  const k = name.toLowerCase();
  return albums.filter((a) => a.kind === 'album' && a.artist.toLowerCase() === k);
}

/* синглы, где артист — основной исполнитель */
function artistOwnSingles(name: string): UiAlbum[] {
  const k = name.toLowerCase();
  return albums.filter((a) => a.kind === 'single' && a.artist.toLowerCase() === k);
}

/* фит артиста в названии сингла («Song ft. X») — балл идёт в профиль артиста */
function artistFeatureSingles(name: string): Array<{ single: UiAlbum; score: number | null }> {
  const k = name.toLowerCase();
  const out: Array<{ single: UiAlbum; score: number | null }> = [];
  for (const s of singlesOnly()) {
    if (s.artist.toLowerCase() === k) continue;
    const feat = (featNameOf(s.title) ?? '').replace(/[),.\s]+$/, '').trim().toLowerCase();
    if (feat && feat === k) out.push({ single: s, score: singleConfirmedScoreOf(s.id) });
  }
  return out;
}

/* альбомы, где артист участвует на фите (но не основной исполнитель) */
function artistFeatureAlbums(name: string): Array<{ album: UiAlbum; score: number | null; count: number }> {
  const k = name.toLowerCase();
  const out: Array<{ album: UiAlbum; score: number | null; count: number }> = [];
  for (const a of albums) {
    if (a.artist.toLowerCase() === k) continue;
    const ft = tracks.filter((t) => t.albumId === a.id && (t.featArtist ?? '').toLowerCase() === k);
    if (ft.length) {
      const vals = ft.map((t) => trackScoreOf(t.id)).filter((s): s is number => s !== null);
      out.push({
        album: a,
        score: vals.length ? round2(vals.reduce((x, y) => x + y, 0) / vals.length) : null,
        count: ft.length,
      });
    }
  }
  return out;
}

/* Средний балл артиста: личные альбомы + фиты + синглы.
   В рейтинги попадают только ПОДТВЕРЖДЁННЫЕ оценки, поэтому,
   пока ползунок не подтверждён, балл артиста не сдвигается. */
function artistScoreOf(name: string): number | null {
  const vals: number[] = [];
  for (const a of artistOwnAlbums(name)) {
    const s = albumConfirmedScoreOf(a.id);
    if (s !== null) vals.push(s);
  }
  for (const f of artistFeatureAlbums(name)) {
    const s = confirmedFeatureAlbumScoreOf(f.album, name);
    if (s !== null) vals.push(s);
  }
  for (const s of artistOwnSingles(name)) {
    const v = singleConfirmedScoreOf(s.id);
    if (v !== null) vals.push(v);
  }
  for (const f of artistFeatureSingles(name)) {
    if (f.score !== null) vals.push(f.score);
  }
  return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
}

/* подтверждённый средний балл треков артиста внутри чужого альбома (фит) */
function confirmedFeatureAlbumScoreOf(album: UiAlbum, artistName: string): number | null {
  const k = artistName.toLowerCase();
  const vals: number[] = [];
  for (const t of tracks) {
    if (t.albumId !== album.id) continue;
    if ((t.featArtist ?? '').toLowerCase() !== k) continue;
    const r = trackRatings[t.id];
    if (r) for (const v of Object.values(r)) if (v.confirmed) vals.push(v.score);
  }
  return meanOf(vals);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

let toastTimer: number | undefined;
function toast(text: string): void {
  let el = document.querySelector<HTMLDivElement>('.toast');
  if (!el) {
    el = document.createElement('div');
    el.className = 'toast';
    el.setAttribute('role', 'status');
    document.body.appendChild(el);
  }
  el.textContent = text;
  requestAnimationFrame(() => el.classList.add('is-visible'));
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => el.classList.remove('is-visible'), 2600);
}

function dataUrlToBlob(dataUrl: string): Blob {
  const [head, body] = dataUrl.split(',');
  const mime = /^data:([^;]+)/.exec(head)?.[1] ?? 'image/jpeg';
  const bin = atob(body);
  const arr = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
  return new Blob([arr], { type: mime });
}

/* Плавное изменение числа (для альбомного балла и средних по трекам) */
const numberAnimations = new WeakMap<HTMLElement, number>();
function tweenText(el: HTMLElement, to: number | null): void {
  const previous = numberAnimations.get(el);
  if (previous !== undefined) cancelAnimationFrame(previous);
  numberAnimations.delete(el);
  if (to === null) {
    el.textContent = '—';
    delete el.dataset.val;
    return;
  }
  const cur = parseFloat(el.textContent ?? '');
  const from = isNaN(cur) ? to : cur;
  if (Math.abs(from - to) < 0.005 || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = fmt(to);
    el.dataset.val = String(to);
    return;
  }
  const start = performance.now();
  const dur = 450;
  el.dataset.val = String(to);
  const step = (now: number): void => {
    const p = Math.min(1, (now - start) / dur);
    const e = 1 - Math.pow(1 - p, 3);
    el.textContent = fmt(from + (to - from) * e);
    if (p < 1 && el.isConnected) numberAnimations.set(el, requestAnimationFrame(step));
    else numberAnimations.delete(el);
  };
  numberAnimations.set(el, requestAnimationFrame(step));
}

/* ---------- DOM ---------- */
const q = <T extends HTMLElement>(sel: string): T => {
  const el = document.querySelector<T>(sel);
  if (!el) throw new Error(`Элемент не найден: ${sel}`);
  return el;
};

const card = q<HTMLDivElement>('#card');
const viewLogin = q<HTMLElement>('#view-login');
const viewHome = q<HTMLElement>('#view-home');
const viewAlbum = q<HTMLElement>('#view-album');
const viewAdd = q<HTMLElement>('#view-add');
const viewArtist = q<HTMLElement>('#view-artist');
const viewProfile = q<HTMLElement>('#view-profile');
const viewRank = q<HTMLElement>('#view-rank');
const viewArank = q<HTMLElement>('#view-arank');
const homeTitle = q<HTMLElement>('#home-title');
const homeMeta = q<HTMLParagraphElement>('#home-meta');
const logoutBtn = q<HTMLButtonElement>('#logout-btn');
const profileBtn = q<HTMLButtonElement>('#profile-btn');
const homeAvatar = q<HTMLSpanElement>('#home-avatar');
const success = q<HTMLDivElement>('#success');

/* вход */
const brandTitle = q<HTMLHeadingElement>('#brand-title');
const loginForm = q<HTMLFormElement>('#login-form');
const emailInput = q<HTMLInputElement>('#email-input');
const passwordInput = q<HTMLInputElement>('#password');
const password2Input = q<HTMLInputElement>('#password2');
const confirmField = q<HTMLDivElement>('#confirm-field');
const toggleBtn = q<HTMLButtonElement>('#toggle-password');
const formError = q<HTMLParagraphElement>('#form-error');
const submitBtn = q<HTMLButtonElement>('#submit-btn');
const submitLabel = q<HTMLSpanElement>('#submit-label');
const authSwitchHint = q<HTMLSpanElement>('#auth-switch-hint');
const authSwitch = q<HTMLButtonElement>('#auth-switch');
const demoHint = q<HTMLParagraphElement>('#demo-hint');

/* альбом */
const albumBack = q<HTMLButtonElement>('#album-back');
const avCoverImg = q<HTMLImageElement>('#av-cover-img');
const avCoverEdit = q<HTMLButtonElement>('#av-cover-edit');
const avCoverEditLabel = q<HTMLSpanElement>('#av-cover-edit-label');
const albumCoverDialog = q<HTMLDialogElement>('#album-cover-dialog');
const albumCoverForm = q<HTMLFormElement>('#album-cover-form');
const albumCoverTitle = q<HTMLHeadingElement>('#album-cover-title');
const albumCoverName = q<HTMLParagraphElement>('#album-cover-name');
const albumCoverPreview = q<HTMLImageElement>('#album-cover-preview');
const albumCoverPick = q<HTMLButtonElement>('#album-cover-pick');
const albumCoverFile = q<HTMLInputElement>('#album-cover-file');
const albumCoverUrl = q<HTMLInputElement>('#album-cover-url');
const albumCoverStatus = q<HTMLParagraphElement>('#album-cover-status');
const albumCoverError = q<HTMLParagraphElement>('#album-cover-error');
const albumCoverCancel = q<HTMLButtonElement>('#album-cover-cancel');
const albumCoverSave = q<HTMLButtonElement>('#album-cover-save');
const avYear = q<HTMLSpanElement>('#av-year');
const avTitle = q<HTMLHeadingElement>('#av-title');
const avArtist = q<HTMLParagraphElement>('#av-artist');
const avAvg = q<HTMLSpanElement>('#av-avg');
const avTracksCount = q<HTMLSpanElement>('#av-tracks-count');
const tracksLockBtn = q<HTMLButtonElement>('#tracks-lock-btn');
const tracksLockLabel = q<HTMLSpanElement>('#tracks-lock-label');
const tracksLockedNote = q<HTMLParagraphElement>('#tracks-locked-note');
const trackForm = q<HTMLFormElement>('#track-form');
const trackInput = q<HTMLInputElement>('#track-input');
const trackFeatBox = q<HTMLDivElement>('#track-feat-box');
const trackFeatInput = q<HTMLInputElement>('#track-feat-input');
const trackFeatList = q<HTMLUListElement>('#track-feat-list');
const trackList = q<HTMLOListElement>('#track-list');
const avImpact = q<HTMLDivElement>('#av-impact');
const avChips = q<HTMLDivElement>('#av-chips');
const avConfirmState = q<HTMLSpanElement>('#av-confirm-state');
const cohesionControl = q<HTMLDivElement>('#cohesion-control');
const typeControl = q<HTMLDivElement>('#type-control');
const albumDeleteBtn = q<HTMLButtonElement>('#album-delete-btn');

/* артист */
const artistBack = q<HTMLButtonElement>('#artist-back');
const artistName = q<HTMLHeadingElement>('#artist-name');
const artistScore = q<HTMLSpanElement>('#artist-score');
const artistOwn = q<HTMLDivElement>('#artist-own');
const artistFeat = q<HTMLDivElement>('#artist-feat');
const artistOwnSection = q<HTMLElement>('#artist-own-section');
const artistSingles = q<HTMLDivElement>('#artist-singles');
const artistSinglesSection = q<HTMLElement>('#artist-singles-section');
const artistFeatSection = q<HTMLElement>('#artist-feat-section');

/* рейтинг артистов */
const rankBack = q<HTMLButtonElement>('#rank-back');
const rankList = q<HTMLOListElement>('#artist-rank-list');
const arankBack = q<HTMLButtonElement>('#arank-back');
const albumRankList = q<HTMLOListElement>('#album-rank-list');
const artistsBtn = q<HTMLButtonElement>('#artists-btn');

/* мой профиль */
const profileBack = q<HTMLButtonElement>('#profile-back');
const profAvatar = q<HTMLSpanElement>('#prof-avatar');
const profUpload = q<HTMLButtonElement>('#prof-upload');
const profRemove = q<HTMLButtonElement>('#prof-remove');
const profFile = q<HTMLInputElement>('#prof-file');
const profName = q<HTMLInputElement>('#prof-name');
const profError = q<HTMLParagraphElement>('#prof-error');
const profSave = q<HTMLButtonElement>('#prof-save');

/* главная: переключатель «альбомы | синглы» */
const homeSwitch = q<HTMLElement>('#home-switch');
const segAlbums = q<HTMLButtonElement>('#seg-albums');
const segSingles = q<HTMLButtonElement>('#seg-singles');
const segThumb = q<HTMLSpanElement>('#seg-thumb');
const homeHdrTitle = q<HTMLHeadingElement>('#home-hdr-title');
const rankBtnLabel = q<HTMLSpanElement>('#rank-btn-label');

/* страница сингла */
const viewSingle = q<HTMLElement>('#view-single');
const singleBack = q<HTMLButtonElement>('#single-back');
const svCoverImg = q<HTMLImageElement>('#sv-cover-img');
const svPeekBtn = q<HTMLButtonElement>('#sv-parent-peek');
const svPeekCard = q<HTMLDivElement>('#sv-peek-card');
const svPeekImg = q<HTMLImageElement>('#sv-peek-img');
const svPeekTitle = q<HTMLSpanElement>('#sv-peek-title');
const svPeekArtist = q<HTMLSpanElement>('#sv-peek-artist');
const svCoverEdit = q<HTMLButtonElement>('#sv-cover-edit');
const svCoverEditLabel = q<HTMLSpanElement>('#sv-cover-edit-label');
const svYear = q<HTMLSpanElement>('#sv-year');
const svTitle = q<HTMLHeadingElement>('#sv-title');
const svArtist = q<HTMLParagraphElement>('#sv-artist');
const svParentLabel = q<HTMLSpanElement>('#sv-parent-label');
const svParentEdit = q<HTMLButtonElement>('#sv-parent-edit');
const svOrigin = q<HTMLParagraphElement>('#sv-origin');
const svAvg = q<HTMLSpanElement>('#sv-avg');
const svConfirmState = q<HTMLSpanElement>('#sv-confirm-state');
const svImpact = q<HTMLDivElement>('#sv-impact');
const svChips = q<HTMLDivElement>('#sv-chips');
const svMine = q<HTMLSpanElement>('#sv-mine');
const svPeer = q<HTMLSpanElement>('#sv-peer');
const svSlider = q<HTMLInputElement>('#sv-slider');
const svNum = q<HTMLInputElement>('#sv-num');
const svConfirmBtn = q<HTMLButtonElement>('#sv-confirm-btn');
const svSave = q<HTMLSpanElement>('#sv-save');
const svNote = q<HTMLParagraphElement>('#sv-note');
const singleDeleteBtn = q<HTMLButtonElement>('#single-delete-btn');

/* рейтинг синглов */
const viewSrank = q<HTMLElement>('#view-srank');
const srankBack = q<HTMLButtonElement>('#srank-back');
const viewTrank = q<HTMLElement>('#view-trank');
const trankBack = q<HTMLButtonElement>('#trank-back');
const trackRankList = q<HTMLOListElement>('#track-rank-list');
const rankMenu = q<HTMLDivElement>('#rank-menu');
const rankMenuList = q<HTMLUListElement>('#rank-menu-list');
const artistLabel = q<HTMLSpanElement>('#artist-label');
const artistNote = q<HTMLParagraphElement>('#artist-note');
const singleRankList = q<HTMLOListElement>('#single-rank-list');

/* синглы на странице альбома */
const avSinglesSection = q<HTMLElement>('#av-singles-section');
const avSingles = q<HTMLDivElement>('#av-singles');
const avSinglesCount = q<HTMLSpanElement>('#av-singles-count');

/* диалог привязки сингла к альбому */
const singleLinkDialog = q<HTMLDialogElement>('#single-link-dialog');
const singleLinkForm = q<HTMLFormElement>('#single-link-form');
const singleLinkName = q<HTMLParagraphElement>('#single-link-name');
const singleLinkBox = q<HTMLDivElement>('#single-link-box');
const singleLinkInput = q<HTMLInputElement>('#single-link-input');
const singleLinkList = q<HTMLUListElement>('#single-link-list');
const singleLinkUnlink = q<HTMLButtonElement>('#single-link-unlink');
const singleLinkCancel = q<HTMLButtonElement>('#single-link-cancel');
const singleLinkSave = q<HTMLButtonElement>('#single-link-save');
const singleLinkError = q<HTMLParagraphElement>('#single-link-error');

/* модальное подтверждение */
const confirmModal = q<HTMLDivElement>('#confirm-modal');
const confirmTitle = q<HTMLHeadingElement>('#confirm-title');
const confirmText = q<HTMLParagraphElement>('#confirm-text');
const confirmOk = q<HTMLButtonElement>('#confirm-ok');
const confirmCancel = q<HTMLButtonElement>('#confirm-cancel');

/* добавление */
const addPanel = q<HTMLDivElement>('#add-panel');
const addBack = q<HTMLButtonElement>('#add-back');
const addForm = q<HTMLFormElement>('#add-form');
const addTitle = q<HTMLHeadingElement>('#add-title');
const titleLabel = q<HTMLSpanElement>('#title-label');
const coverNote = q<HTMLParagraphElement>('#cover-note');
const parentField = q<HTMLDivElement>('#parent-field');
const parentBox = q<HTMLDivElement>('#parent-box');
const parentInput = q<HTMLInputElement>('#parent-input');
const parentList = q<HTMLUListElement>('#parent-list');
const parentNote = q<HTMLParagraphElement>('#parent-note');
const artistBox = q<HTMLDivElement>('#artist-box');
const artistField = q<HTMLDivElement>('#artist-field');
const artistInput = q<HTMLInputElement>('#artist-input');
const artistList = q<HTMLUListElement>('#artist-list');
const evaluatorField = q<HTMLDivElement>('#evaluator-field');
const evaluatorPicker = q<HTMLDivElement>('#evaluator-picker');
const evaluatorInput = q<HTMLInputElement>('#evaluator-input');
const evaluatorTrigger = q<HTMLButtonElement>('#evaluator-trigger');
const evaluatorValue = q<HTMLSpanElement>('#evaluator-value');
const evaluatorList = q<HTMLUListElement>('#evaluator-list');
const titleInput = q<HTMLInputElement>('#title-input');
const titleError = q<HTMLParagraphElement>('#title-error');
const yearInput = q<HTMLInputElement>('#year-input');
const coverPick = q<HTMLDivElement>('#cover-pick');
const coverFile = q<HTMLInputElement>('#cover-file');
const coverImg = q<HTMLImageElement>('#cover-img');
const coverRemove = q<HTMLButtonElement>('#cover-remove');
const coverUrl = q<HTMLInputElement>('#cover-url');
const coverUrlError = q<HTMLParagraphElement>('#cover-url-error');
const addSubmit = q<HTMLButtonElement>('#add-submit');
const addSubmitLabel = q<HTMLSpanElement>('#add-submit-label');
const addError = q<HTMLParagraphElement>('#add-error');

/* ---------- Переходы между экранами ---------- */
async function swapTo(from: HTMLElement, to: HTMLElement, after?: () => void): Promise<void> {
  if (from === viewAdd) setEvaluatorOpen(false);
  from.classList.add('is-leaving');
  await sleep(560);
  from.classList.remove('is-visible', 'is-leaving');
  from.style.display = 'none';
  to.style.display = '';
  to.classList.remove('is-visible');
  requestAnimationFrame(() => {
    to.classList.add('is-visible');
    if (after) after();
    flushSynchronizedRender();
  });
}

/* ---------- Вход / выход ---------- */
let isRegisterMode = false;
let authBusy = false;

function showError(text: string): void {
  formError.textContent = text;
  formError.classList.add('is-visible');
}
function clearError(): void {
  formError.textContent = '';
  formError.classList.remove('is-visible');
}

toggleBtn.addEventListener('click', () => {
  const willShow = passwordInput.type === 'password';
  passwordInput.type = willShow ? 'text' : 'password';
  toggleBtn.classList.toggle('is-visible', willShow);
  toggleBtn.setAttribute('aria-label', willShow ? 'Скрыть пароль' : 'Показать пароль');
  passwordInput.focus();
});

authSwitch.addEventListener('click', () => {
  isRegisterMode = !isRegisterMode;
  brandTitle.textContent = isRegisterMode ? 'Регистрация' : 'Вход';
  submitLabel.textContent = isRegisterMode ? 'Создать аккаунт' : 'Войти';
  confirmField.hidden = !isRegisterMode;
  authSwitchHint.textContent = isRegisterMode ? 'уже есть аккаунт?' : 'нет аккаунта?';
  authSwitch.textContent = isRegisterMode ? 'войти' : 'создать';
  clearError();
});

loginForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (authBusy) return;
  void handleAuthSubmit();
});

async function handleAuthSubmit(): Promise<void> {
  const email = emailInput.value.trim();
  const password = passwordInput.value;
  clearError();
  if (!email) { showError('Введите почту'); shake(); return; }
  if (!password) { showError('Введите пароль'); shake(); return; }
  if (isRegisterMode && password !== password2Input.value) {
    showError('Пароли не совпадают');
    shake();
    return;
  }

  authBusy = true;
  submitBtn.classList.add('is-loading');
  try {
    if (CLOUD) {
      if (isRegisterMode) await registerCloud(email, password);
      else await loginCloud(email, password);
    } else {
      await loginLocal(email, password);
    }
    await refreshData();
    subscribeRealtime();
    await enterHome();
  } catch (err) {
    showError(messageOf(err));
    shake();
  } finally {
    authBusy = false;
    submitBtn.classList.remove('is-loading');
  }
}

async function enterHome(): Promise<void> {
  homeTitle.textContent = currentUser?.username ?? 'Гость';
  setAvatarEl(homeAvatar, currentUser);
  success.classList.add('is-visible');
  await sleep(1350);
  success.classList.remove('is-visible');
  await swapTo(viewLogin, viewHome, () => {
    viewHome.scrollTop = 0;
    moveSegThumb();
  });
  passwordInput.value = '';
  password2Input.value = '';
  renderAlbums();
  toast(`Добро пожаловать, ${currentUser?.username ?? ''}!`);
}

logoutBtn.addEventListener('click', () => {
  void (async () => {
    stopRealtime();
    if (CLOUD) await getSB().auth.signOut();
    currentUser = null;
    currentAlbumId = null;
    currentSingleId = null;
    currentArtistName = null;
    pendingSingleRatings.clear(); // черновики оценок не переносятся на другого участника
    viewStack.length = 0;
    viewStack.push({ view: 'home' });
    await swapTo(viewHome, viewLogin);
    viewHome.querySelectorAll<HTMLElement>('.album').forEach((el) => {
      el.classList.add('reveal');
      el.style.animation = '';
    });
    card.classList.remove('enter');
    void card.offsetWidth;
    card.classList.add('enter');
  })();
});

/* ---------- Переключатель «альбомы | синглы» на главной ---------- */
function moveSegThumb(): void {
  const btn = homeMode === 'album' ? segAlbums : segSingles;
  if (!btn.offsetWidth) return; // главная ещё не показана — пересчитаем при отрисовке
  segThumb.style.width = `${btn.offsetWidth}px`;
  segThumb.style.left = `${btn.offsetLeft}px`;
  homeSwitch.dataset.mode = homeMode;
}

function applyHomeMode(): void {
  const albumMode = homeMode === 'album';
  segAlbums.classList.toggle('is-active', albumMode);
  segSingles.classList.toggle('is-active', !albumMode);
  segAlbums.setAttribute('aria-selected', String(albumMode));
  segSingles.setAttribute('aria-selected', String(!albumMode));
  segAlbums.tabIndex = albumMode ? 0 : -1;
  segSingles.tabIndex = albumMode ? -1 : 0;
  homeHdrTitle.textContent = albumMode ? 'Альбомы' : 'Синглы';
  rankBtnLabel.textContent = 'рейтинги';
  moveSegThumb();
}

/** true — раздел синглов сейчас недоступен (в облаке не выполнен migrate.sql). */
function singlesUnavailable(): boolean {
  return CLOUD && !singlesReady;
}

function setHomeMode(mode: ReleaseKind, rerender = true): void {
  if (homeMode !== mode) {
    homeMode = mode;
    saveHomeMode();
  }
  applyHomeMode();
  if (rerender) renderAlbums();
}

segAlbums.addEventListener('click', () => setHomeMode('album'));
segSingles.addEventListener('click', () => setHomeMode('single'));
homeSwitch.addEventListener('keydown', (e) => {
  if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
  e.preventDefault();
  const next: ReleaseKind = homeMode === 'album' ? 'single' : 'album';
  setHomeMode(next);
  (next === 'album' ? segAlbums : segSingles).focus();
});
window.addEventListener('resize', moveSegThumb);

/* ---------- Карточки релизов на главной ---------- */
function renderAlbums(animate = true): void {
  const grid = q<HTMLDivElement>('#albums');
  grid.innerHTML = '';
  const singleMode = homeMode === 'single';
  const list = singleMode ? singlesOnly() : albumsOnly();

  if (singleMode && singlesUnavailable()) {
    const hint = document.createElement('p');
    hint.className = 'home__notice';
    hint.textContent = 'Раздел синглов пока не подключён к базе: выполните migrate.sql в Supabase, и синглы станут доступны.';
    grid.appendChild(hint);
    homeMeta.textContent = 'синглы недоступны';
    applyHomeMode();
    return;
  }

  list.forEach((a, i) => {
    const el = singleMode ? makeSingleCard(a, animate, i) : makeAlbumCard(a, null, animate, i);
    grid.appendChild(el);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = animate ? 'album album--add reveal' : 'album album--add';
  add.style.setProperty('--d', `${(0.2 + list.length * 0.07).toFixed(2)}s`);
  add.innerHTML = `<span class="album__plus">+</span><span class="album__addtext">добавить ${singleMode ? 'сингл' : 'альбом'}</span>`;
  add.addEventListener('click', () => openAdd(singleMode ? 'single' : 'album'));
  add.addEventListener('animationend', () => {
    if (add.classList.contains('reveal')) {
      add.classList.remove('reveal');
      add.style.animation = 'none';
    }
  });
  grid.appendChild(add);

  if (singleMode) {
    const values = singlesOnly().map((s) => singleScoreOf(s.id)).filter((v): v is number => v !== null);
    const overall = meanOf(values);
    homeMeta.textContent = `${list.length} ${singlesPlural(list.length)}${
      overall !== null ? ' · средняя оценка ' + fmt(overall) : ''
    }${values.length < list.length ? ' · часть оценок ещё не подтверждена' : ''}`;
  } else {
    const values = albumsOnly().map((a) => albumScoreOf(a.id)).filter((v): v is number => v !== null);
    const overall = meanOf(values);
    homeMeta.textContent = `${list.length} ${plural(list.length)}${
      overall !== null ? ' · средняя оценка ' + fmt(overall) : ''
    }`;
  }
  applyHomeMode();
}

/* ==========================================================================
   СТРАНИЦА АЛЬБОМА
   ========================================================================== */

function currentAlbum(): UiAlbum | undefined {
  return albums.find((a) => a.id === currentAlbumId);
}

function renderAlbumCover(al: UiAlbum): void {
  avCoverImg.src = coverSrc(al);
  avCoverImg.alt = `${al.artist} — ${al.title}`;
  avCoverImg.style.opacity = ''; // сброс после анимации осыпания
  avCoverEdit.hidden = !currentUser;
  avCoverEditLabel.textContent = al.cover ? 'изменить обложку' : 'добавить обложку';
}

function renderAlbumPage(al: UiAlbum): void {
  renderEvaluator(al, '#av-evaluator');
  avTitle.textContent = al.title;
  avArtist.innerHTML = `<a class="av__artist-link" data-artist="${esc(al.artist)}">${esc(al.artist)}</a>`;
  avYear.textContent = String(al.year);
  renderAlbumCover(al);
  const score = albumScoreOf(al.id);
  avAvg.textContent = score === null ? '—' : fmt(score);
  delete avAvg.dataset.val;
  renderTracks();
  renderAlbumSingles();
  renderImpact();
  renderConfirmState();
  renderFinalize();
}

/* --- обложка существующего альбома --- */
let editingCoverAlbumId: string | null = null;
let albumCoverDraft: string | null = null;
let albumCoverPreparing = false;
let albumCoverSaving = false;
let albumCoverClosing = false;
let albumCoverRequest = 0;
let albumCoverUrlTimer: number | undefined;

function showAlbumCoverError(text = ''): void {
  albumCoverError.textContent = text;
  albumCoverError.classList.toggle('is-visible', Boolean(text));
}

function updateAlbumCoverControls(): void {
  const blocked = albumCoverSaving || albumCoverClosing;
  albumCoverPick.disabled = blocked;
  albumCoverFile.disabled = blocked;
  albumCoverUrl.disabled = blocked;
  albumCoverCancel.disabled = blocked;
  albumCoverSave.disabled = blocked || albumCoverPreparing || !albumCoverDraft;
  albumCoverSave.classList.toggle('is-loading', albumCoverSaving);
  albumCoverSave.setAttribute('aria-busy', String(albumCoverSaving));
  albumCoverStatus.textContent = albumCoverSaving ? 'Сохраняем обложку…'
    : albumCoverPreparing ? 'Подготавливаем изображение…' : '';
  dlgCoverSearch.setBlocked(blocked);
}

function resetAlbumCoverDraft(): number {
  window.clearTimeout(albumCoverUrlTimer);
  albumCoverRequest += 1; // поздние ответы от предыдущего файла/URL больше не применяются
  albumCoverDraft = null;
  albumCoverPreparing = false;
  showAlbumCoverError();
  dlgCoverSearch.clearSelection(); // выбрали файл/ссылку руками — подсветка варианта не нужна
  const al = albums.find((a) => a.id === editingCoverAlbumId);
  if (al) albumCoverPreview.src = coverSrc(al);
  updateAlbumCoverControls();
  return albumCoverRequest;
}

function openAlbumCoverEditor(): void {
  const al = currentAlbum() ?? currentSingle();
  if (!al || !currentUser || albumCoverDialog.open) return;
  editingCoverAlbumId = al.id;
  albumCoverForm.reset();
  albumCoverTitle.textContent = al.kind === 'single'
    ? (al.cover ? 'Изменить обложку сингла' : 'Обложка сингла')
    : (al.cover ? 'Изменить обложку' : 'Добавить обложку');
  albumCoverName.textContent = releaseFullName(al);
  resetAlbumCoverDraft();
  albumCoverDialog.showModal();
  // Фиксируем начальные стили после showModal(), чтобы окно и фон плавно появились.
  void albumCoverDialog.offsetWidth;
  albumCoverDialog.classList.add('is-open');
  // Поиск обложки онлайн: чистый лист и сразу авто-поиск по артисту и названию.
  dlgCoverSearch.reset();
  dlgCoverSearch.syncContext(400);
}

function closeAlbumCoverEditor(): void {
  if (albumCoverSaving || albumCoverClosing || !albumCoverDialog.open) return;
  albumCoverClosing = true;
  window.clearTimeout(albumCoverUrlTimer);
  albumCoverRequest += 1;
  albumCoverDraft = null;
  albumCoverPreparing = false;
  updateAlbumCoverControls();
  albumCoverDialog.classList.remove('is-open');

  const finishClose = (): void => {
    albumCoverDialog.close();
    albumCoverClosing = false;
    editingCoverAlbumId = null;
    albumCoverForm.reset();
    albumCoverPreview.removeAttribute('src');
    showAlbumCoverError();
    dlgCoverSearch.reset();
    updateAlbumCoverControls();
  };
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    finishClose();
    return;
  }
  // Не очищаем предпросмотр и не снимаем модальность до конца затухания.
  // При отмене перехода (например, смене настройки анимаций) тоже закрываем окно.
  const animations = albumCoverDialog.getAnimations({ subtree: true })
    // Учитываем ::backdrop, но не бесконечную анимацию спиннера внутри формы.
    .filter((animation) => (animation.effect as KeyframeEffect | null)?.target === albumCoverDialog);
  void Promise.allSettled(animations.map((animation) => animation.finished)).then(finishClose);
}

async function previewAlbumCover(source: File | string, request: number): Promise<void> {
  try {
    let src: string;
    if (typeof source === 'string') {
      let url: URL;
      try { url = new URL(source); }
      catch { throw new Error('Нужна прямая ссылка вида https://…'); }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') {
        throw new Error('Нужна прямая ссылка вида https://…');
      }
      src = url.href;
      await loadImage(src);
    } else {
      src = await prepareCoverFile(source);
    }
    if (!albumCoverDialog.open || request !== albumCoverRequest) return;
    albumCoverDraft = src;
    albumCoverPreview.src = src;
  } catch (err) {
    if (albumCoverDialog.open && request === albumCoverRequest) showAlbumCoverError(messageOf(err));
  } finally {
    if (request === albumCoverRequest) {
      albumCoverPreparing = false;
      updateAlbumCoverControls();
    }
  }
}

avCoverEdit.addEventListener('click', openAlbumCoverEditor);
svCoverEdit.addEventListener('click', openAlbumCoverEditor);
albumCoverPick.addEventListener('click', () => albumCoverFile.click());
albumCoverCancel.addEventListener('click', closeAlbumCoverEditor);
albumCoverDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeAlbumCoverEditor();
});
albumCoverDialog.addEventListener('click', (e) => {
  if (e.target !== albumCoverDialog) return;
  const rect = albumCoverDialog.getBoundingClientRect();
  if (e.clientX < rect.left || e.clientX > rect.right || e.clientY < rect.top || e.clientY > rect.bottom) {
    closeAlbumCoverEditor();
  }
});

albumCoverFile.addEventListener('change', () => {
  const file = albumCoverFile.files?.[0];
  albumCoverFile.value = ''; // можно повторно выбрать тот же файл, в том числе после ошибки
  if (!file || albumCoverSaving || albumCoverClosing || !albumCoverDialog.open) return;
  const request = resetAlbumCoverDraft();
  albumCoverUrl.value = '';
  albumCoverPreparing = true;
  updateAlbumCoverControls();
  void previewAlbumCover(file, request);
});

albumCoverUrl.addEventListener('input', () => {
  if (albumCoverSaving || albumCoverClosing || !albumCoverDialog.open) return;
  const request = resetAlbumCoverDraft();
  const url = albumCoverUrl.value.trim();
  if (!url) return;
  albumCoverPreparing = true;
  updateAlbumCoverControls();
  albumCoverUrlTimer = window.setTimeout(() => void previewAlbumCover(url, request), 400);
});

/**
 * Эффект «свежей обложки» после замены: новая обложка проявляется с лёгким
 * увеличением, по ней проходит блик и вспыхивает лавандовый контур.
 * Стартуем по событию load, чтобы анимация не играла на старом изображении.
 * Класс снимаем фиксированным таймаутом: после окончания анимаций (≈1.3 с)
 * он визуально ничего не меняет, а окно остаётся предсказуемым.
 */
const coverFreshTimers = new WeakMap<HTMLElement, number>();

function playCoverFresh(img: HTMLImageElement): void {
  const fig = img.closest('figure');
  if (!fig) return;
  fig.classList.remove('is-fresh');
  window.clearTimeout(coverFreshTimers.get(fig));
  void fig.offsetWidth; // перезапуск, если эффект ещё не отыграл
  const start = () => {
    fig.classList.add('is-fresh');
    coverFreshTimers.set(fig, window.setTimeout(() => fig.classList.remove('is-fresh'), 2000));
  };
  if (img.complete && img.naturalWidth > 0) start();
  else img.addEventListener('load', start, { once: true });
}

/** Замена видимой обложки при фоновой сверке: играем эффект, если обложка
    уже была (не первое добавление) и действительно поменялась. */
function maybePlayCoverFresh(img: HTMLImageElement, nextSrc: string): void {
  const prev = img.getAttribute('src') ?? '';
  if (!prev || prev === nextSrc) return;
  if (prev.startsWith('data:image/svg')) return; // была заглушка — это добавление, не замена
  playCoverFresh(img);
}

async function saveAlbumCover(albumId: string, source: string): Promise<void> {
  if (!currentUser) throw new Error('Войдите в аккаунт заново');
  if (!albums.some((a) => a.id === albumId)) throw new Error('Альбом больше не доступен');
  const before = albums.find((a) => a.id === albumId)?.cover ?? '';
  let url = source;
  if (CLOUD) {
    if (source.startsWith('data:')) url = await uploadCover(source);
    // Обновляем только обложку: треки, оценки и финальные выборы не затрагиваются.
    const { error } = await getSB().from('albums').update({ cover_url: url })
      .eq('id', albumId).select('id').single();
    if (error) {
      if (error.code === 'PGRST116') throw new Error('Альбом больше не доступен. Обновите страницу.');
      throw new Error('Не удалось сохранить обложку: ' + messageOf(error));
    }
  }
  const next = albums.map((a) => a.id === albumId ? { ...a, cover: url } : a);
  if (!CLOUD) {
    // Не меняем интерфейс и не сообщаем об успехе, если localStorage заполнен.
    try { localStorage.setItem(LS_KEY, JSON.stringify(next)); }
    catch { throw new Error('Не удалось сохранить обложку в браузере. Возможно, закончилось место. Попробуйте ссылку вместо файла.'); }
  }
  albums = next;
  // Эффект — только при замене существующей обложки, не при первом добавлении.
  const replaced = Boolean(before) && before !== url;
  const al = currentAlbum();
  if (al?.id === albumId) {
    renderAlbumCover(al);
    if (replaced) playCoverFresh(avCoverImg);
  }
  const s = currentSingle();
  if (s?.id === albumId) {
    renderSingleCover(s);
    if (replaced) playCoverFresh(svCoverImg);
    if (currentAlbumId) renderAlbumSingles(); // обложка сингла могла браться у альбома
  }
}

albumCoverForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void handleAlbumCoverSave();
});

async function handleAlbumCoverSave(): Promise<void> {
  if (!editingCoverAlbumId || !albumCoverDraft || albumCoverPreparing || albumCoverSaving || albumCoverClosing) return;
  albumCoverSaving = true;
  showAlbumCoverError();
  updateAlbumCoverControls();
  try {
    await saveAlbumCover(editingCoverAlbumId, albumCoverDraft);
    albumCoverSaving = false;
    closeAlbumCoverEditor();
    toast('Обложка сохранена');
  } catch (err) {
    showAlbumCoverError(messageOf(err));
  } finally {
    albumCoverSaving = false;
    updateAlbumCoverControls();
  }
}

function updateRatingDisplays(changedTrackId?: string): void {
  if (!currentAlbumId) return;
  const al = currentAlbum();
  if (!al) return;
  tweenText(avAvg, albumScoreOf(al.id));
  const list = tracks.filter((t) => t.albumId === al.id);
  if (changedTrackId) {
    const el = trackList.querySelector<HTMLElement>(`[data-tid="${changedTrackId}"]`);
    if (el) tweenText(el, trackScoreOf(changedTrackId));
  } else {
    for (const t of list) {
      const el = trackList.querySelector<HTMLElement>(`[data-tid="${t.id}"]`);
      if (el) tweenText(el, trackScoreOf(t.id));
    }
  }
  renderImpact();
  renderConfirmState();
}

/* --- вклад участников в общий балл --- */
function renderImpact(): void {
  avChips.innerHTML = '';
  if (!currentAlbumId) { avImpact.hidden = true; return; }
  const list = tracks.filter((t) => t.albumId === currentAlbumId);
  const hasAny = list.some((t) => {
    const r = trackRatings[t.id];
    return r && Object.keys(r).length > 0;
  });
  if (!hasAny) { avImpact.hidden = true; return; }
  avImpact.hidden = false;

  const rows: Array<{ id: string; username: string; initials: string; avatarUrl: string | null; mean: number | null; n: number }> = [];
  for (const [pid, info] of profileCache) {
    if (!requiredEvaluators(currentAlbum() ?? {}, profileCache.keys()).includes(pid)) continue;
    let sum = 0, n = 0;
    for (const t of list) {
      const v = trackRatings[t.id]?.[pid];
      if (v) { sum += v.score; n += 1; }
    }
    rows.push({ id: pid, username: info.username, initials: info.initials, avatarUrl: info.avatarUrl, mean: n ? round2(sum / n) : null, n });
  }
  rows.sort((a, b) => Number(b.id === currentUser?.id) - Number(a.id === currentUser?.id));

  for (const r of rows) {
    const isMe = r.id === currentUser?.id;
    const chip = document.createElement('div');
    chip.className = 'av__chip' + (isMe ? ' is-me' : '');
    const label = isMe ? 'я' : esc(r.username);
    chip.innerHTML = `
      ${avatarMarkup(r, 'av__chip-who')}
      <span class="av__chip-val">${r.mean === null ? '—' : fmt(r.mean)}</span>
      <span class="av__chip-sub">${label} · ${r.n} из ${list.length}</span>`;
    chip.title = `${r.username}: ${r.mean === null ? 'нет оценок' : fmt(r.mean) + ' в среднем'} · ${r.n}/${list.length} треков`;
    avChips.appendChild(chip);
  }
}

/* статус подтверждения итогового балла альбома */
function renderConfirmState(): void {
  const al = currentAlbum();
  if (!al || albumScoreOf(al.id) === null) {
    avConfirmState.hidden = true;
    return;
  }
  const final = albumAllConfirmed(al.id);
  avConfirmState.hidden = false;
  avConfirmState.classList.toggle('is-final', final);
  avConfirmState.innerHTML = final
    ? `${CHECK_SVG}<span>подтверждён</span>`
    : `${PENDING_SVG}<span>не подтверждён</span>`;
}

/* --- финальные выборы: целостность и тип релиза --- */
const CHEVRON_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';

function finSelectHTML(kind: string, options: Array<{ value: string; label: string }>): string {
  const opts = options
    .map((o, i) => `<li><button type="button" class="fin-select__option" role="option" data-value="${esc(o.value)}" style="--d:${i * 28}ms">${esc(o.label)}</button></li>`)
    .join('');
  return `<div class="fin-select" data-kind="${kind}">
    <button type="button" class="fin-select__trigger" aria-haspopup="listbox" aria-expanded="false">
      <span class="fin-select__value">— выбрать —</span>
      <span class="fin-select__chevron">${CHEVRON_SVG}</span>
    </button>
    <ul class="fin-select__list" role="listbox">${opts}</ul>
  </div>`;
}

function finalBadgeHTML(text: string, animate: boolean): string {
  const icon = animate
    ? `<span class="final__icon">
         <svg class="final__check-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>
         <svg class="final__lock-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>
       </span>`
    : `<span class="final__icon">${LOCK_SVG}</span>`;
  return `<div class="av__fin-final${animate ? ' av__fin-done' : ''}">
    ${icon}
    <span class="final__text">${esc(text)}</span>
    <span class="final__tag">финально</span>
  </div>`;
}

function renderFinalize(animateKind?: 'cohesion' | 'type'): void {
  const al = currentAlbum();
  if (!al) {
    cohesionControl.innerHTML = '';
    typeControl.innerHTML = '';
    return;
  }
  cohesionControl.innerHTML = al.cohesion === null
    ? (canEvaluate(al, currentUser?.id)
      ? finSelectHTML('cohesion', COHESION_OPTIONS.map((o, i) => ({ value: String(i + 1), label: o })))
      : '<p class="cover-pick__note">Выбирает назначенный участник</p>')
    : finalBadgeHTML(COHESION_OPTIONS[al.cohesion - 1] ?? '—', animateKind === 'cohesion');
  typeControl.innerHTML = al.albumType === null
    ? finSelectHTML('type', TYPE_OPTIONS)
    : finalBadgeHTML(typeLabelOf(al.albumType), animateKind === 'type');
}

function closeAllFinSelects(): void {
  document.querySelectorAll<HTMLElement>('.fin-select.is-open').forEach((el) => {
    el.classList.remove('is-open');
    const tr = el.querySelector<HTMLButtonElement>('.fin-select__trigger');
    if (tr) tr.setAttribute('aria-expanded', 'false');
  });
}

viewAlbum.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  const trigger = t.closest<HTMLButtonElement>('.fin-select__trigger');
  if (trigger) {
    const root = trigger.closest<HTMLElement>('.fin-select');
    if (!root) return;
    const wasOpen = root.classList.contains('is-open');
    closeAllFinSelects();
    if (!wasOpen) {
      root.classList.add('is-open');
      trigger.setAttribute('aria-expanded', 'true');
    }
    return;
  }
  const opt = t.closest<HTMLButtonElement>('.fin-select__option');
  if (opt) {
    const root = opt.closest<HTMLElement>('.fin-select');
    if (root) onFinOptionPick(root, opt.dataset.value ?? '', opt.textContent ?? '');
  }
});

document.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (!t.closest('.fin-select')) closeAllFinSelects();
});

function onFinOptionPick(root: HTMLElement, value: string, label: string): void {
  root.querySelectorAll<HTMLButtonElement>('.fin-select__option').forEach((b) => {
    b.classList.toggle('is-selected', b.dataset.value === value);
  });
  const valueEl = root.querySelector<HTMLElement>('.fin-select__value');
  if (valueEl) valueEl.textContent = label;
  closeAllFinSelects();
  void onFinalizePick(root.dataset.kind ?? '', value, label);
}

async function onFinalizePick(kind: string, value: string, label: string): Promise<void> {
  const al = currentAlbum();
  if (!al) { renderFinalize(); return; }
  if (!value) return;

  const isCohesion = kind === 'cohesion';
  if (isCohesion && !canEvaluate(al, currentUser?.id)) { renderFinalize(); return; }
  const current = isCohesion ? al.cohesion : al.albumType;
  if (current !== null) { renderFinalize(); return; } // уже финально

  const title = isCohesion ? 'Зафиксировать целостность?' : 'Зафиксировать тип релиза?';
  const ok = await openConfirm(
    title,
    `«${label}» — выбор станет окончательным и его нельзя будет изменить никому из вас.`,
  );
  if (!ok) { renderFinalize(); return; }

  try {
    if (isCohesion) await saveCohesion(Number(value));
    else await saveAlbumType(value);
    toast(isCohesion ? 'Целостность зафиксирована' : 'Тип релиза зафиксирован');
  } catch (err) {
    toast(messageOf(err));
    void refreshData().then(() => renderFinalize()).catch(() => renderFinalize());
  }
}

async function saveCohesion(v: number): Promise<void> {
  const al = currentAlbum();
  if (!al || !canEvaluate(al, currentUser?.id)) return;
  if (CLOUD) {
    const { error } = await getSB().from('albums').update({ cohesion: v }).eq('id', al.id);
    if (error) throw error;
  }
  al.cohesion = v;
  if (!CLOUD) saveLocalAlbums();
  renderFinalize('cohesion');
}

async function saveAlbumType(v: string): Promise<void> {
  const al = currentAlbum();
  if (!al) return;
  if (CLOUD) {
    const { error } = await getSB().from('albums').update({ album_type: v }).eq('id', al.id);
    if (error) throw error;
  }
  al.albumType = v;
  if (!CLOUD) saveLocalAlbums();
  renderFinalize('type');
}

/* --- модальное подтверждение --- */
let confirmResolve: ((ok: boolean) => void) | null = null;

interface ConfirmLabels { ok?: string; cancel?: string; }

let confirmSeq = 0;

function openConfirm(title: string, text: string, danger = false, labels: ConfirmLabels = {}): Promise<boolean> {
  return new Promise((resolve) => {
    confirmSeq += 1;
    confirmTitle.textContent = title;
    confirmText.innerHTML = text;
    confirmOk.classList.toggle('is-danger', danger);
    confirmOk.textContent = labels.ok ?? (danger ? 'удалить' : 'подтвердить');
    confirmCancel.textContent = labels.cancel ?? 'отмена';
    confirmModal.hidden = false;
    requestAnimationFrame(() => confirmModal.classList.add('is-open'));
    confirmResolve = resolve;
  });
}

function closeConfirm(ok: boolean): void {
  confirmModal.classList.remove('is-open');
  const res = confirmResolve;
  const seq = confirmSeq;
  confirmResolve = null;
  window.setTimeout(() => {
    confirmModal.hidden = true;
    // Подписи кнопок сбрасываем только после того, как окно скрылось:
    // иначе «да / назад» на глазах превращаются в «подтвердить / отмена».
    if (seq !== confirmSeq) return;
    confirmOk.textContent = 'подтвердить';
    confirmCancel.textContent = 'отмена';
    confirmOk.classList.remove('is-danger');
  }, 320);
  res?.(ok);
}

confirmOk.addEventListener('click', () => closeConfirm(true));
confirmCancel.addEventListener('click', () => closeConfirm(false));
confirmModal.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-confirm-close]')) closeConfirm(false);
});

/* --- оценка трека: слайдер + число, реал-тайм с дебаунсом --- */
let ratingPointerTrackId: string | null = null;
const saveTimers = new Map<string, number>();
const ratingWrites = new Map<string, Promise<void>>();

/* Тач-экран (нет мыши): ползунок оценки «вооружается» только после тапа по строке —
   случайное касание больше не дёргает балл. Пока строка не выделена, слайдер не ловит
   пальцы (pointer-events: none в styles.css); числовое поле и ✓ доступны сразу.
   На десктопе (точерный указатель) поведение не меняется. */
const TOUCH_UI = window.matchMedia('(hover: none) and (pointer: coarse)');
let activeTrackId: string | null = null;

function applyActiveTrackClass(): void {
  trackList.querySelectorAll<HTMLLIElement>('.track.is-active').forEach((el) => el.classList.remove('is-active'));
  if (!activeTrackId) return;
  const li = trackList.querySelector<HTMLLIElement>(`.track[data-id="${activeTrackId}"]`);
  if (!li) {
    activeTrackId = null; // трек исчез (удалён/пересинхронизирован) — выделение сбрасываем
    return;
  }
  li.classList.add('is-active');
}

function setActiveTrack(id: string | null): void {
  if (activeTrackId === id) return;
  activeTrackId = id;
  applyActiveTrackClass();
}

function setTrackSave(trackId: string, s: 'save' | 'done' | 'err' | ''): void {
  const li = trackList.querySelector<HTMLLIElement>(`[data-id="${trackId}"]`);
  const el = li?.querySelector<HTMLElement>('.track__save');
  if (!el) return;
  const map: Record<string, string> = { save: 'сохраняю…', done: 'сохранено', err: 'ошибка', '': '' };
  el.textContent = map[s];
  el.classList.toggle('is-visible', s !== '');
  if (s === 'done') {
    window.setTimeout(() => {
      if (el.textContent === 'сохранено') el.classList.remove('is-visible');
    }, 1600);
  }
}

function setTrackRating(trackId: string, v: number): void {
  if (!currentUser || !canRateTrack(trackId)) return;
  const prev = trackRatings[trackId]?.[currentUser.id];
  (trackRatings[trackId] ??= {})[currentUser.id] = { score: v, confirmed: prev?.confirmed === true };
  if (!CLOUD) saveLocalRatings();
  setTrackSave(trackId, 'save');
  updateRatingDisplays(trackId);
  scheduleTrackSave(trackId);
}

function clearTrackRating(trackId: string): void {
  if (!currentUser || !canRateTrack(trackId)) return;
  const r = trackRatings[trackId];
  if (r) {
    delete r[currentUser.id];
    if (!Object.keys(r).length) delete trackRatings[trackId];
  }
  if (!CLOUD) saveLocalRatings();
  setTrackSave(trackId, 'save');
  updateRatingDisplays(trackId);
  scheduleTrackSave(trackId);
}

function stageRatingSave(trackId: string): PendingRating {
  const value = currentUser ? trackRatings[trackId]?.[currentUser.id] : null;
  const pending: PendingRating = { value: value ? { ...value } : null };
  pendingRatings.set(trackId, pending);
  return pending;
}

/** Запускает отложенную запись трека, не трогая «соседнее» хранилище сингла. */
function armTrackSave(trackId: string): void {
  window.clearTimeout(saveTimers.get(trackId));
  saveTimers.set(trackId, window.setTimeout(() => {
    saveTimers.delete(trackId);
    void persistTrackRating(trackId).catch((err) => toast(messageOf(err)));
  }, 500));
}

function scheduleTrackSave(trackId: string): void {
  stageRatingSave(trackId);
  mirrorTrackToSingle(trackId);
  armTrackSave(trackId);
}

function persistTrackRating(trackId: string): Promise<void> {
  if (!currentUser || !canRateTrack(trackId)) return Promise.resolve();
  window.clearTimeout(saveTimers.get(trackId));
  saveTimers.delete(trackId);
  const existing = ratingWrites.get(trackId);
  if (existing) return existing;
  const profileId = currentUser.id;
  const epoch = syncEpoch;
  const task = (async () => {
    // Только одна запись на трек одновременно: поздний ответ не запишет старый балл поверх нового.
    while (epoch === syncEpoch && currentUser?.id === profileId) {
      const pending = pendingRatings.get(trackId);
      if (!pending || pending.savedAfterRead !== undefined) return;
      pending.failed = false;
      setTrackSave(trackId, 'save');
      try {
        if (CLOUD) {
          const result = pending.value
            ? await getSB().from('ratings').upsert(
              { track_id: trackId, profile_id: profileId, ...pending.value },
              { onConflict: 'track_id,profile_id' },
            )
            : await getSB().from('ratings').delete().eq('track_id', trackId).eq('profile_id', profileId);
          if (result.error) throw result.error;
        } else saveLocalRatings();
      } catch (err) {
        if (epoch !== syncEpoch) return;
        if (pendingRatings.get(trackId) !== pending) continue;
        pending.failed = true;
        setTrackSave(trackId, 'err');
        throw err;
      }
      if (epoch !== syncEpoch) return;
      if (pendingRatings.get(trackId) !== pending) continue; // за время запроса ввели новый балл
      pending.savedAfterRead = dataReadRevision;
      setTrackSave(trackId, 'done');
      requestSync(0);
      return;
    }
  })().finally(() => {
    if (ratingWrites.get(trackId) === task) ratingWrites.delete(trackId);
  });
  ratingWrites.set(trackId, task);
  return task;
}

/* Подтверждение использует ту же очередь, что и изменение балла. */
async function toggleRatingConfirm(trackId: string): Promise<void> {
  if (!currentUser || !canRateTrack(trackId)) return;
  const entry = trackRatings[trackId]?.[currentUser.id];
  if (!entry) return;
  const epoch = syncEpoch;
  const previous = entry.confirmed;
  const next = !previous;
  entry.confirmed = next;
  const pending = stageRatingSave(trackId);
  mirrorTrackToSingle(trackId, true);
  if (!CLOUD) saveLocalRatings();
  syncTrackRatingControls();
  renderConfirmState();
  // Новое состояние кнопки видно сразу, и она остаётся нажимаемой, пока идёт запись:
  // иначе быстрый повторный клик по ✓ (например, сразу после правки балла) попадал бы
  // в заблокированную кнопку и терялся.
  if (epoch === syncEpoch) toast(next ? 'Оценка подтверждена' : 'Оценку можно менять');
  try {
    await persistTrackRating(trackId);
  } catch (err) {
    if (epoch !== syncEpoch) return;
    if (pendingRatings.get(trackId) === pending) {
      const mine = trackRatings[trackId]?.[currentUser.id];
      if (mine) {
        mine.confirmed = previous;
        pending.value = { ...mine };
      }
      if (!CLOUD) saveLocalRatings();
    }
    mirrorTrackToSingle(trackId, true); // откат тоже должен уехать в сингл
    // Откат надо показать и в строке трека: без этого поле балла остаётся заблокированным,
    // будто оценка подтверждена, хотя запись не удалась (синхронизация контролов строки
    // раньше происходила в finally, который убрали вместе с блокировкой кнопки на время записи).
    syncTrackRatingControls();
    renderConfirmState();
    toast(messageOf(err));
  }
}

/* Иконка кнопки подтверждения перерисовывается только вместе с состоянием.
   Если переписать innerHTML кнопки, по которой уже прошёл mousedown (например, её
   нажали сразу после ввода балла — синхронизация успевает сработать на blur поля),
   то узел под курсором исчезнет и браузер не пришлёт click: кнопка «не нажимается». */
function setConfirmIcon(btn: HTMLButtonElement, confirmed: boolean): void {
  const icon = confirmed ? 'pencil' : 'check';
  if (btn.dataset.icon === icon) return;
  btn.dataset.icon = icon;
  btn.innerHTML = confirmed ? PENCIL_SVG : CHECK_SVG;
}

function applyRatingLockState(li: HTMLLIElement, confirmed: boolean): void {
  const permitted = canRateTrack(li.dataset.id ?? '');
  li.classList.toggle('is-rated-locked', confirmed || !permitted);
  const slider = li.querySelector<HTMLInputElement>('.track__slider');
  const num = li.querySelector<HTMLInputElement>('.track__numinput');
  const btn = li.querySelector<HTMLButtonElement>('.track__confirm-btn');
  if (slider) slider.disabled = confirmed || !permitted;
  if (num) num.disabled = confirmed || !permitted;
  if (btn) {
    setConfirmIcon(btn, confirmed);
    btn.title = confirmed ? 'Изменить оценку' : 'Подтвердить оценку';
    btn.setAttribute('aria-label', confirmed ? 'Изменить оценку' : 'Подтвердить оценку');
  }
}

/* --- треки --- */
const GRIP_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="9" cy="6" r="1.6"/><circle cx="15" cy="6" r="1.6"/><circle cx="9" cy="12" r="1.6"/><circle cx="15" cy="12" r="1.6"/><circle cx="9" cy="18" r="1.6"/><circle cx="15" cy="18" r="1.6"/></svg>';
const UP_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 15l6-6 6 6"/></svg>';
const DOWN_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>';
const DEL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>';
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="4.5" y="10.5" width="15" height="10" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 7.8-1.4"/></svg>';
const PENCIL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3l4 4L8 20l-5 1 1-5L17 3z"/></svg>';
const CHECK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 12.5l5 5 10-11"/></svg>';
const PENDING_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/></svg>';
const SINGLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3M5.4 5.4l2.1 2.1M16.5 16.5l2.1 2.1M18.6 5.4l-2.1 2.1M7.5 16.5l-2.1 2.1"/></svg>';
const UNMARK_SINGLE_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3.2"/><path d="M12 2.6v3M12 18.4v3M2.6 12h3M18.4 12h3"/><path d="M4 20L20 4"/></svg>';

/* название трека с ссылкой-неоном на фитующего артиста */
function trackTitleHTML(t: UiTrack): string {
  const name = (t.featArtist ?? '').trim();
  const escTitle = esc(t.title);
  if (!name) return escTitle;
  const idx = t.title.toLowerCase().indexOf(name.toLowerCase());
  if (idx < 0) {
    return `${escTitle} <a class="track__feat" data-artist="${esc(name)}" href="#">ft. ${esc(name)}</a>`;
  }
  const before = esc(t.title.slice(0, idx));
  const mid = esc(t.title.slice(idx, idx + name.length));
  const after = esc(t.title.slice(idx + name.length));
  return `${before}<a class="track__feat" data-artist="${esc(name)}" href="#">${mid}</a>${after}`;
}

function peerRatingHTML(trackId: string): string {
  const peer = peerRatingOf(trackId);
  return peer?.confirmed
    ? `<span class="track__peer" title="оценка ${esc(peer.username)} · подтверждена">
         ${avatarMarkup(peer, 'track__peer-who')}
         <span class="track__peer-val">${fmt(peer.score)}</span>
       </span>`
    : '';
}

/* Меняем только значения/бейджи, сохраняя DOM, фокус, положение курсора и слайдера. */
function syncTrackRatingControls(): void {
  const myId = currentUser?.id;
  if (!myId) return;
  for (const li of trackList.querySelectorAll<HTMLLIElement>('.track')) {
    const id = li.dataset.id!;
    const mine = trackRatings[id]?.[myId];
    const slider = li.querySelector<HTMLInputElement>('.track__slider');
    const num = li.querySelector<HTMLInputElement>('.track__numinput');
    const editing = document.activeElement === slider || document.activeElement === num || ratingPointerTrackId === id;
    if (!editing) {
      if (slider) slider.value = String(mine?.score ?? 5);
      if (num) num.value = mine ? fmt(mine.score) : '';
    }
    applyRatingLockState(li, mine?.confirmed === true);
    const confirm = li.querySelector<HTMLButtonElement>('.track__confirm-btn');
    if (confirm) confirm.disabled = !mine || !canRateTrack(id);
    const html = peerRatingHTML(id);
    if (li.dataset.peerHtml !== html) {
      li.querySelector('.track__peer')?.remove();
      li.querySelector('.track__title, .track__rename-input')?.insertAdjacentHTML('afterend', html);
      li.dataset.peerHtml = html;
    }
  }
}

function renderTracks(enterId?: string): void {
  tracksRenderDeferred = false;
  const al = currentAlbum();
  const locked = al?.tracksLocked ?? false;
  const list = tracks.filter((t) => t.albumId === currentAlbumId).sort((a, b) => a.position - b.position);
  const myId = currentUser?.id ?? '';

  trackList.innerHTML = '';

  list.forEach((t, i) => {
    const mine = trackRatings[t.id]?.[myId];
    const mineScore = typeof mine?.score === 'number' ? mine.score : undefined;
    const mineConfirmed = mine?.confirmed === true;
    const permitted = canRateTrack(t.id);
    const tavg = trackScoreOf(t.id);
    const tavgStr = tavg === null ? '—' : fmt(tavg);
    const mineStr = typeof mineScore === 'number' ? fmt(mineScore) : '';
    /* Фиксация количества треков запрещает добавлять, удалять и менять порядок,
       но названия править можно и при ней. Переименование запрещает только
       личная фиксация названия трека (t.locked). */
    const canRename = !t.locked;
    const canOrder = !locked;               // только фиксация количества запрещает порядок/удаление
    const single = singleOfTrack(t);

    const li = document.createElement('li');
    li.className = 'track';
    if (t.locked) li.classList.add('is-locked');
    if (locked) li.classList.add('is-frozen');
    if (mineConfirmed || !permitted) li.classList.add('is-rated-locked');
    if (single) li.classList.add('track--single');
    li.dataset.id = t.id;
    if (single) li.dataset.singleId = single.id;

    const actions = [
      canRename ? `<button class="track__btn" data-act="rename" type="button" aria-label="Переименовать">${PENCIL_SVG}</button>` : '',
      canOrder ? `<button class="track__btn" data-act="up" type="button" aria-label="Выше"${i === 0 ? ' disabled' : ''}>${UP_SVG}</button>` : '',
      canOrder ? `<button class="track__btn" data-act="down" type="button" aria-label="Ниже"${i === list.length - 1 ? ' disabled' : ''}>${DOWN_SVG}</button>` : '',
      `<button class="track__btn${single ? ' is-on' : ''}" data-act="${single ? 'unsingle' : 'single'}" type="button" title="${single ? 'Снять метку «сингл»' : 'Отметить как сингл'}" aria-label="${single ? 'Снять метку «сингл»' : 'Отметить как сингл'}">${single ? UNMARK_SINGLE_SVG : SINGLE_SVG}</button>`,
      `<button class="track__btn track__genius${t.geniusId ? ' is-on' : ''}" data-act="genius" type="button" title="Текст песни с Genius" aria-label="Текст песни с Genius">${GENIUS_MARK_SVG}</button>`,
      isAdmin() ? `<button class="track__btn" data-act="lock" type="button" aria-label="${t.locked ? 'Снять фиксацию названия' : 'Зафиксировать название'}" title="${t.locked ? 'Снять фиксацию названия' : 'Зафиксировать название'}">${t.locked ? UNLOCK_SVG : LOCK_SVG}</button>` : '',
      canOrder ? `<button class="track__btn track__btn--del" data-act="del" type="button" aria-label="Удалить">${DEL_SVG}</button>` : '',
    ].join('');

    const peerBadge = peerRatingHTML(t.id);
    li.dataset.peerHtml = peerBadge;

    li.innerHTML = `
      <div class="track__row1">
        <span class="track__handle"${canOrder ? ' draggable="true"' : ''} aria-hidden="true">${GRIP_SVG}</span>
        <span class="track__num">${i + 1}</span>
        <span class="track__title">${trackTitleHTML(t)}</span>
        ${single ? `<button class="track__single" type="button" title="Открыть страницу сингла «${esc(singleDisplayTitle(single))}»">сингл</button>` : ''}
        ${peerBadge}
        ${t.locked ? `<span class="track__lock" title="название зафиксировано">${LOCK_SVG}</span>` : ''}
        <span class="track__avg" data-tid="${t.id}" title="средняя по треку">${tavgStr}</span>
        <span class="track__actions">${actions}</span>
      </div>
      <div class="track__row2">
        <span class="track__rate-label">${permitted ? 'моя оценка' : 'без права оценки'}</span>
        <input class="track__slider" type="range" min="0" max="10" step="0.01" value="${typeof mineScore === 'number' ? mineScore : 5}" aria-label="Моя оценка"${mineConfirmed || !permitted ? ' disabled' : ''} />
        <input class="track__numinput" type="number" min="0" max="10" step="0.01" inputmode="decimal" placeholder="—" value="${mineStr}"${mineConfirmed || !permitted ? ' disabled' : ''} />
        <button class="track__confirm-btn" type="button"${permitted && typeof mineScore === 'number' ? '' : ' disabled'} aria-label="${mineConfirmed ? 'Изменить оценку' : 'Подтвердить оценку'}" title="${mineConfirmed ? 'Изменить оценку' : 'Подтвердить оценку'}">${mineConfirmed ? PENCIL_SVG : CHECK_SVG}</button>
        <span class="track__save" aria-live="polite"></span>
      </div>`;

    trackList.appendChild(li);
    const pending = pendingRatings.get(t.id);
    if (pending) setTrackSave(t.id, pending.failed ? 'err' : pending.savedAfterRead !== undefined ? 'done' : 'save');
  });

  avTracksCount.textContent = `${list.length} ${tracksPlural(list.length)}`;

  trackForm.hidden = locked;
  tracksLockedNote.hidden = !locked;
  tracksLockBtn.hidden = !isAdmin();
  if (isAdmin()) tracksLockLabel.textContent = locked ? 'разблокировать' : 'зафиксировать количество';

  if (enterId) {
    const el = trackList.querySelector<HTMLLIElement>(`[data-id="${enterId}"]`);
    if (el) el.classList.add('track--enter');
  }
  applyActiveTrackClass();
}

/* события ввода оценки (делегирование) */
trackList.addEventListener('input', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('track__slider')) {
    const li = target.closest<HTMLLIElement>('.track');
    if (!li || !li.dataset.id) return;
    const v = round2(parseFloat((target as HTMLInputElement).value));
    const num = li.querySelector<HTMLInputElement>('.track__numinput');
    if (num) num.value = fmt(v);
    setTrackRating(li.dataset.id, v);
    syncTrackRatingControls();   // балл появился — ✓ снова доступна
  } else if (target.classList.contains('track__numinput')) {
    const li = target.closest<HTMLLIElement>('.track');
    if (!li || !li.dataset.id) return;
    const raw = (target as HTMLInputElement).value.trim();
    if (raw === '') {
      const slider = li.querySelector<HTMLInputElement>('.track__slider');
      if (slider) slider.value = '5';
      clearTrackRating(li.dataset.id);
      const cbtn = li.querySelector<HTMLButtonElement>('.track__confirm-btn');
      if (cbtn) cbtn.disabled = true;
      return;
    }
    let v = parseFloat(raw);
    if (isNaN(v)) return;
    v = round2(Math.min(10, Math.max(0, v)));
    const slider = li.querySelector<HTMLInputElement>('.track__slider');
    if (slider) slider.value = String(v);
    setTrackRating(li.dataset.id, v);
    syncTrackRatingControls();   // балл появился — ✓ снова доступна
  }
});

trackList.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  if (target.matches('.track__slider, .track__numinput')) {
    ratingPointerTrackId = target.closest<HTMLElement>('.track')?.dataset.id ?? null;
  }
});

function finishTrackInteraction(): void {
  requestAnimationFrame(() => {
    flushDeferredTrackRender();
    syncTrackRatingControls();
  });
}
trackList.addEventListener('focusout', finishTrackInteraction);
trackList.addEventListener('dragend', finishTrackInteraction);
for (const event of ['pointerup', 'pointercancel']) {
  document.addEventListener(event, () => {
    if (!ratingPointerTrackId) return;
    ratingPointerTrackId = null;
    finishTrackInteraction();
  });
}

/* --- фит: появление поля при ft./feat./& в названии --- */
let lastFeatExtract = '';

function resetTrackForm(): void {
  trackInput.value = '';
  trackFeatInput.value = '';
  trackFeatBox.hidden = true;
  trackFeatList.hidden = true;
  lastFeatExtract = '';
}

trackInput.addEventListener('input', () => {
  const title = trackInput.value;
  const detected = FEAT_RE.test(title);
  trackFeatBox.hidden = !detected;
  if (detected) {
    const ext = featNameOf(title) ?? '';
    if (ext && (trackFeatInput.value.trim() === '' || trackFeatInput.value.trim() === lastFeatExtract)) {
      trackFeatInput.value = ext;
    }
    lastFeatExtract = ext;
  } else {
    trackFeatInput.value = '';
    lastFeatExtract = '';
  }
});

/* автодополнение артиста на фите */
function updateFeatList(): void {
  const q0 = trackFeatInput.value.trim().toLowerCase();
  const names = allArtistNames();
  const matches = q0 ? names.filter((n) => n.toLowerCase().includes(q0)) : names;
  trackFeatList.innerHTML = '';

  if (!matches.length && q0) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'combo__item combo__item--new';
    btn.innerHTML = `<span class="combo__name">новый артист: «${esc(trackFeatInput.value.trim())}»</span>`;
    btn.addEventListener('pointerdown', (e) => { e.preventDefault(); pickFeat(trackFeatInput.value.trim()); });
    li.appendChild(btn);
    trackFeatList.appendChild(li);
  } else {
    for (const n of matches.slice(0, 6)) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'combo__item';
      btn.innerHTML = `<span class="combo__name">${esc(n)}</span><span class="combo__tag">артист</span>`;
      btn.addEventListener('pointerdown', (e) => { e.preventDefault(); pickFeat(n); });
      li.appendChild(btn);
      trackFeatList.appendChild(li);
    }
  }
  trackFeatList.hidden = trackFeatList.children.length === 0;
}

function pickFeat(name: string): void {
  trackFeatInput.value = name;
  trackFeatList.hidden = true;
  lastFeatExtract = name;
}

trackFeatInput.addEventListener('input', updateFeatList);
trackFeatInput.addEventListener('focus', updateFeatList);
trackFeatInput.addEventListener('blur', () => {
  window.setTimeout(() => { trackFeatList.hidden = true; }, 120);
});
document.addEventListener('click', (e) => {
  const combo = document.querySelector<HTMLElement>('.av__feat-combo');
  if (combo && !combo.contains(e.target as Node)) trackFeatList.hidden = true;
});

/* добавление трека */
trackForm.addEventListener('submit', (e) => {
  e.preventDefault();
  void handleAddTrack();
});

async function handleAddTrack(): Promise<void> {
  const al = currentAlbum();
  const title = trackInput.value.trim();
  if (!title || !al || !currentAlbumId) return;
  if (al.tracksLocked) return;
  const featRaw = trackFeatBox.hidden ? '' : trackFeatInput.value.trim();
  const featArtist = featRaw ? canonicalArtistName(featRaw) : null;
  const position = tracks.filter((t) => t.albumId === currentAlbumId).length;
  let newId: string;
  try {
    if (CLOUD) {
      const { data, error } = await getSB().from('tracks').insert({
        album_id: currentAlbumId, title, position, locked: false, feat_artist: featArtist,
      }).select();
      if (error) throw error;
      newId = (data?.[0] as { id: string }).id;
    } else {
      newId = 't' + Date.now().toString(36);
      tracks.push({ id: newId, albumId: currentAlbumId, title, position, locked: false, featArtist, singleId: null, geniusId: null });
      saveLocalTracks();
    }
    if (CLOUD) await refreshData();
    resetTrackForm();
    renderTracks(newId);
  } catch (err) {
    toast(messageOf(err));
  }
}

/* удаление трека */
async function deleteTrack(id: string): Promise<void> {
  const t = tracks.find((x) => x.id === id);
  const al = currentAlbum();
  if (!t || !al || al.tracksLocked) return;
  try {
    if (CLOUD) {
      const { error } = await getSB().from('tracks').delete().eq('id', id);
      if (error) throw error;
      await refreshData();
    } else {
      tracks = tracks.filter((x) => x.id !== id);
      tracks.forEach((x, i) => { x.position = i; });
      saveLocalTracks();
    }
    renderTracks();
    updateRatingDisplays();
  } catch (err) {
    toast(messageOf(err));
  }
}

/* переименование */
function startRename(li: HTMLLIElement): void {
  const id = li.dataset.id;
  if (!id) return;
  const titleEl = li.querySelector<HTMLElement>('.track__title');
  if (!titleEl) return;
  const input = document.createElement('input');
  input.className = 'track__rename-input';
  input.type = 'text';
  input.value = titleEl.textContent ?? '';
  titleEl.replaceWith(input);
  input.focus();
  input.select();
  let done = false;
  const commit = (): void => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (v && v !== (titleEl.textContent ?? '')) void renameTrack(id, v);
    else renderTracks();
  };
  const cancel = (): void => {
    if (done) return;
    done = true;
    renderTracks();
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') cancel();
  });
  input.addEventListener('blur', commit);
}

async function renameTrack(id: string, title: string): Promise<void> {
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  try {
    if (CLOUD) {
      const { error } = await getSB().from('tracks').update({ title }).eq('id', id);
      if (error) throw error;
      t.title = title;
    } else {
      t.title = title;
      saveLocalTracks();
    }
    renderTracks();
  } catch (err) {
    toast(messageOf(err));
  }
}

/* фиксация названия трека (админ) */
async function toggleTrackLock(id: string): Promise<void> {
  if (!isAdmin()) return;
  const t = tracks.find((x) => x.id === id);
  if (!t) return;
  t.locked = !t.locked;
  try {
    if (CLOUD) {
      const { error } = await getSB().from('tracks').update({ locked: t.locked }).eq('id', id);
      if (error) throw error;
    } else {
      saveLocalTracks();
    }
    renderTracks();
    toast(t.locked ? 'Название зафиксировано' : 'Фиксация названия снята');
  } catch (err) {
    t.locked = !t.locked;
    toast(messageOf(err));
  }
}

/* блокировка количества треков (админ) */
tracksLockBtn.addEventListener('click', () => void toggleTracksLock());

async function toggleTracksLock(): Promise<void> {
  if (!isAdmin()) return;
  const al = currentAlbum();
  if (!al) return;
  al.tracksLocked = !al.tracksLocked;
  try {
    if (CLOUD) {
      const { error } = await getSB().from('albums').update({ tracks_locked: al.tracksLocked }).eq('id', al.id);
      if (error) throw error;
    } else {
      saveLocalAlbums();
    }
    renderTracks();
    toast(al.tracksLocked ? 'Количество треков зафиксировано' : 'Разблокировано');
  } catch (err) {
    al.tracksLocked = !al.tracksLocked;
    toast(messageOf(err));
  }
}

/* порядок треков: кнопки вверх/вниз */
async function moveTrack(from: number, to: number): Promise<void> {
  const list = tracks.filter((t) => t.albumId === currentAlbumId).sort((a, b) => a.position - b.position);
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return;
  const [item] = list.splice(from, 1);
  list.splice(to, 0, item);
  list.forEach((t, i) => { t.position = i; });
  try {
    await persistTrackOrder();
    renderTracks();
  } catch (err) {
    toast(messageOf(err));
  }
}

async function persistTrackOrder(): Promise<void> {
  const list = tracks.filter((t) => t.albumId === currentAlbumId).sort((a, b) => a.position - b.position);
  if (CLOUD) {
    const rows = list.map((t, i) => ({ id: t.id, album_id: currentAlbumId, title: t.title, position: i, locked: t.locked }));
    const { error } = await getSB().from('tracks').upsert(rows);
    if (error) throw error;
  } else {
    saveLocalTracks();
  }
}

/* Нажатие на трек, помеченный синглом: строка спрашивает, перейти ли на страницу,
   бейдж «сингл» открывает её сразу. Поля оценки, кнопки и ссылки не перехватываются. */
/* Тач: тап по строке — выделение (подсветка) и «вооружение» ползунка; повторный тап
   по строке снимает выделение. Контролы со своим поведением не участвуют; название
   трека, помеченного синглом, сохраняет прежнее поведение (модалка перехода).
   Поглощаем тап меткой на событии: обработчик модалки перехода его увидит, а
   document-уровневые (закрытие fin-select, подсказок, меню) работают как раньше. */
type RowTapEvent = MouseEvent & { __trackRowTap?: boolean };
trackList.addEventListener('click', (e) => {
  if (!TOUCH_UI.matches) return;
  const target = e.target as HTMLElement;
  if (target.closest('.track__btn, .track__single, .track__feat, .track__numinput, .track__confirm-btn, .track__rename-input, .track__slider')) return;
  const li = target.closest<HTMLLIElement>('.track');
  if (!li?.dataset.id) return;
  if (li.classList.contains('track--single') && target.closest('.track__title')) return;
  setActiveTrack(activeTrackId === li.dataset.id ? null : li.dataset.id);
  (e as RowTapEvent).__trackRowTap = true;
});

trackList.addEventListener('click', (e) => {
  // Тач: тап по строке уже потреблён выделением (метка __trackRowTap) — модалку не показываем.
  if ((e as RowTapEvent).__trackRowTap) return;
  const target = e.target as HTMLElement;
  // Плашка «сингл» открывает страницу сразу (свой обработчик ниже) — модалку не показываем.
  if (target.closest('.track__slider, .track__numinput, .track__rename-input, .track__confirm-btn, .track__btn, .track__feat, .track__handle, .track__single')) return;
  const marked = target.closest<HTMLLIElement>('.track--single');
  if (!marked?.dataset.id) return;
  const row = tracks.find((t) => t.id === marked.dataset.id);
  if (row && singleOfTrack(row)) void promptSingleFromTrack(row);
});

/* клики по кнопкам треков */
trackList.addEventListener('click', (e) => {
  const featLink = (e.target as HTMLElement).closest<HTMLAnchorElement>('.track__feat');
  if (featLink) {
    e.preventDefault();
    const name = featLink.dataset.artist;
    if (name) void openArtist(name);
    return;
  }
  const singleBadge = (e.target as HTMLElement).closest<HTMLButtonElement>('.track__single');
  if (singleBadge) {
    const li = singleBadge.closest<HTMLLIElement>('.track');
    const row = li?.dataset.id ? tracks.find((t) => t.id === li.dataset.id) : undefined;
    const single = row ? singleOfTrack(row) : undefined;
    if (single) void openSingle(single.id);
    return;
  }
  const geniusBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.track__genius');
  if (geniusBtn) {
    const cli = geniusBtn.closest<HTMLLIElement>('.track');
    if (cli?.dataset.id) toggleTrackGenius(cli.dataset.id);
    return;
  }
  const confirmBtn = (e.target as HTMLElement).closest<HTMLButtonElement>('.track__confirm-btn');
  if (confirmBtn) {
    if (confirmBtn.disabled) return;
    const cli = confirmBtn.closest<HTMLLIElement>('.track');
    if (cli && cli.dataset.id) void toggleRatingConfirm(cli.dataset.id);
    return;
  }
  const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.track__btn');
  if (!btn || btn.disabled) return;
  const li = (e.target as HTMLElement).closest<HTMLLIElement>('.track');
  if (!li || !li.dataset.id) return;
  const id = li.dataset.id;
  const list = tracks.filter((t) => t.albumId === currentAlbumId).sort((a, b) => a.position - b.position);
  const idx = list.findIndex((t) => t.id === id);
  const act = btn.dataset.act;
  const track = tracks.find((t) => t.id === id);
  if (act === 'up') void moveTrack(idx, idx - 1);
  else if (act === 'down') void moveTrack(idx, idx + 1);
  else if (act === 'del') void deleteTrack(id);
  else if (act === 'lock') void toggleTrackLock(id);
  else if (act === 'rename') startRename(li);
  else if (act === 'single' && track) void markTrackAsSingle(track);
  else if (act === 'unsingle' && track) void unmarkTrackAsSingle(track);
});

/* drag & drop треков (FLIP-анимации).
   Тянуть можно ТОЛЬКО за ручку-точки слева: слайдер и поля не захватываются. */
trackList.addEventListener('dragstart', (e) => {
  const handle = (e.target as HTMLElement).closest<HTMLElement>('.track__handle');
  if (!handle || handle.getAttribute('draggable') !== 'true') { e.preventDefault(); return; }
  const li = handle.closest<HTMLLIElement>('.track');
  if (!li || !li.dataset.id) { e.preventDefault(); return; }
  e.dataTransfer!.effectAllowed = 'move';
  try { e.dataTransfer!.setDragImage(li, 24, 24); } catch { /* ignore */ }
  try { e.dataTransfer!.setData('text/plain', li.dataset.id); } catch { /* ignore */ }
  li.classList.add('dragging');
});

function animateTrackReorder(container: HTMLElement): () => void {
  const items = [...container.querySelectorAll<HTMLElement>('.track:not(.dragging)')];
  items.forEach((el) => { el.style.transition = 'none'; el.style.transform = ''; });
  const before = new Map(items.map((el) => [el, el.getBoundingClientRect()]));
  return () => {
    items.forEach((el) => {
      const b = before.get(el);
      if (!b) return;
      const a = el.getBoundingClientRect();
      const dy = b.top - a.top;
      if (Math.abs(dy) > 0.5) {
        el.style.transition = 'none';
        el.style.transform = `translateY(${dy}px)`;
        void el.offsetHeight; // reflow
        el.style.transition = 'transform 0.28s cubic-bezier(0.22, 1, 0.36, 1)';
        el.style.transform = '';
      }
    });
  };
}

trackList.addEventListener('dragover', (e) => {
  e.preventDefault();
  const dragging = trackList.querySelector<HTMLLIElement>('.track.dragging');
  if (!dragging) return;
  const apply = animateTrackReorder(trackList);
  const after = getDragAfterElement(trackList, e.clientY);
  if (after == null) trackList.appendChild(dragging);
  else trackList.insertBefore(dragging, after);
  apply();
});

trackList.addEventListener('drop', (e) => e.preventDefault());

trackList.addEventListener('dragend', () => {
  const dragging = trackList.querySelector<HTMLLIElement>('.track.dragging');
  if (dragging) dragging.classList.remove('dragging');
  trackList.querySelectorAll<HTMLElement>('.track').forEach((el) => { el.style.transform = ''; });

  const ids = [...trackList.querySelectorAll<HTMLLIElement>('.track')].map((el) => el.dataset.id ?? '');
  const byId = new Map(tracks.map((t) => [t.id, t]));
  const next = ids.map((id) => byId.get(id)).filter((t): t is UiTrack => Boolean(t));
  if (next.length !== tracks.length) return;
  const changed = next.some((t, i) => tracks[i].id !== t.id);
  if (!changed) return;
  const list = next.filter((t) => t.albumId === currentAlbumId).sort((a, b) => a.position - b.position);
  list.forEach((t, i) => { t.position = i; });
  void persistTrackOrder().then(() => renderTracks()).catch((err) => toast(messageOf(err)));
});

function getDragAfterElement(container: HTMLElement, y: number): HTMLLIElement | null {
  const els = [...container.querySelectorAll<HTMLLIElement>('.track:not(.dragging)')];
  let closest: { offset: number; element: HTMLLIElement | null } = { offset: -Infinity, element: null };
  for (const child of els) {
    const box = child.getBoundingClientRect();
    const offset = y - box.top - box.height / 2;
    if (offset < 0 && offset > closest.offset) closest = { offset, element: child };
  }
  return closest.element;
}

/* --- навигация (единый стек) --- */
function visibleView(): HTMLElement | null {
  for (const v of [viewHome, viewAlbum, viewSingle, viewArtist, viewProfile, viewRank, viewArank, viewSrank, viewTrank, viewAdd]) {
    if (v.classList.contains('is-visible')) return v;
  }
  return null;
}

function topEntry(): ViewEntry {
  return viewStack[viewStack.length - 1] ?? { view: 'home' };
}

async function navigateTo(view: HTMLElement, entry: ViewEntry): Promise<void> {
  const from = visibleView() ?? viewHome;
  viewStack.push(entry);
  await swapTo(from, view, () => { view.scrollTop = 0; });
}

/* вернуться на предыдущий экран */
async function goBack(): Promise<void> {
  viewStack.pop(); // снимаем текущий экран
  if (viewAlbum.classList.contains('is-visible')) setActiveTrack(null); // уходим со страницы альбома — выделение не несём с собой
  const prev = topEntry();
  const from = visibleView() ?? viewHome;
  switch (prev.view) {
    case 'album': {
      currentAlbumId = prev.albumId ?? null;
      currentSingleId = null;
      const al = albums.find((a) => a.id === prev.albumId);
      if (al) renderAlbumPage(al);
      await swapTo(from, viewAlbum, () => { viewAlbum.scrollTop = 0; });
      break;
    }
    case 'single': {
      currentSingleId = prev.singleId ?? null;
      currentAlbumId = null;
      const s = albums.find((a) => a.id === prev.singleId);
      if (s) renderSinglePage(s);
      await swapTo(from, viewSingle, () => { viewSingle.scrollTop = 0; });
      break;
    }
    case 'artist': {
      currentAlbumId = null;
      currentSingleId = null;
      if (currentArtistName) renderArtistPage();
      await swapTo(from, viewArtist, () => { viewArtist.scrollTop = 0; });
      break;
    }
    case 'profile': {
      currentAlbumId = null;
      currentSingleId = null;
      currentArtistName = null;
      renderProfilePage();
      await swapTo(from, viewProfile, () => { viewProfile.scrollTop = 0; });
      break;
    }
    case 'rank': {
      currentAlbumId = null;
      currentSingleId = null;
      currentArtistName = null;
      renderArtistRank();
      await swapTo(from, viewRank, () => { viewRank.scrollTop = 0; });
      break;
    }
    case 'arank': {
      currentAlbumId = null;
      currentSingleId = null;
      currentArtistName = null;
      renderAlbumRank();
      await swapTo(from, viewArank, () => { viewArank.scrollTop = 0; });
      break;
    }
    case 'trank': {
      currentAlbumId = null;
      currentSingleId = null;
      currentArtistName = null;
      renderTrackRank();
      await swapTo(from, viewTrank, () => { viewTrank.scrollTop = 0; });
      break;
    }
    case 'add': {
      currentAlbumId = null;
      currentSingleId = null;
      applyAddMode(prev.kind);
      await swapTo(from, viewAdd, () => { viewAdd.scrollTop = 0; });
      break;
    }
    default: {
      currentAlbumId = null;
      currentSingleId = null;
      currentArtistName = null;
      renderAlbums();
      await swapTo(from, viewHome, () => { viewHome.scrollTop = 0; });
    }
  }
}

/* --- открытие страницы релиза (альбом или сингл) --- */
async function openRelease(id: string): Promise<void> {
  const rel = albums.find((a) => a.id === id);
  if (!rel) return;
  if (rel.kind === 'single') await openSingle(id);
  else await openAlbum(id);
}

/* --- открытие/закрытие страницы альбома --- */
async function openAlbum(id: string): Promise<void> {
  const al = albums.find((a) => a.id === id);
  if (!al) return;
  currentAlbumId = id;
  currentSingleId = null;
  resetTrackForm();
  renderAlbumPage(al);
  await navigateTo(viewAlbum, { view: 'album', albumId: id });
}

albumBack.addEventListener('click', () => void goBack());

/* --- профиль артиста --- */
function makeAlbumCard(a: UiAlbum, featScore: number | null = null, animate = false, index = 0): HTMLElement {
  const el = document.createElement('article');
  el.className = animate ? 'album reveal' : 'album';
  if (animate) el.style.setProperty('--d', `${(0.2 + index * 0.07).toFixed(2)}s`);
  const single = a.kind === 'single';
  const avg = single ? singleScoreOf(a.id) : albumScoreOf(a.id);
  const avgStr = avg === null ? '—' : fmt(avg);
  const n = trackCountOf(a.id);
  const parent = single ? parentOf(a) : undefined;
  const title = single ? singleDisplayTitle(a) : a.title;
  /* У сингла треков нет (макси-синглы не ведём), поэтому «0 треков» не пишем:
     показываем количество оценок релиза, а пока оценок нет — ничего. */
  const votes = single ? singleVotesOf(a.id) : 0;
  const pending = single ? pendingCountOf(a.id) : 0;
  const countHTML = single
    ? (votes
      ? `<span class="album__count">${votes} ${votesPlural(votes)}</span>${pending ? `<span class="album__votes-count">${pending} без подтверждения</span>` : ''}`
      : '')
    : `<span class="album__count">${n} ${tracksPlural(n)}</span>`;
  el.innerHTML = `
    <div class="album__cover">
      <img src="${esc(coverSrc(a))}" alt="${esc(singleArtistText(a))} — ${esc(title)}" loading="lazy">
      <span class="album__year">${a.year}</span>
      ${single ? '<span class="album__badge">сингл</span>' : ''}
      ${a.albumType ? `<span class="album__type">${esc(typeLabelOf(a.albumType))}</span>` : ''}
      ${featScore !== null ? `<span class="album__featbadge">фит ${fmt(featScore)}</span>` : ''}
    </div>
    <div class="album__body">
      <h3 class="album__title">${esc(title)}</h3>
      <p class="album__artist">${singleArtistHTML(a, 'album__artist-link')}</p>
      ${parent ? `<div class="album__parent">${parentLinksHtml(a)}</div>` : ''}
      <div class="album__rating">
        <div class="album__avg">
          <span class="album__avg-num">${avgStr}</span>
          <span class="album__avg-of">/10</span>
        </div>
        <div class="album__votes">${countHTML}</div>
      </div>
    </div>`;
  el.addEventListener('click', (ev) => {
    if (handleParentClick(ev)) return;
    // Ссылку на артиста обрабатывает обработчик сетки (главная): карточка её не перехватывает,
    // иначе одно нажатие открыло бы и релиз, и профиль артиста.
    if ((ev.target as HTMLElement).closest('.album__artist-link')) return;
    void openRelease(a.id);
  });
  if (animate) {
    el.addEventListener('animationend', () => {
      if (el.classList.contains('reveal')) {
        el.classList.remove('reveal');
        el.style.animation = 'none';
      }
    });
  }
  return el;
}

/* карточка сингла: без треков, с баллом релиза и ссылкой на артиста */
function makeSingleCard(s: UiAlbum, animate = false, index = 0): HTMLElement {
  const el = document.createElement('article');
  el.className = animate ? 'album album--single reveal' : 'album album--single';
  if (animate) el.style.setProperty('--d', `${(0.2 + index * 0.07).toFixed(2)}s`);
  const avg = singleScoreOf(s.id);
  const parent = parentOf(s);
  const votes = singleVotesOf(s.id);
  const pending = pendingCountOf(s.id);
  const title = singleDisplayTitle(s);
  el.innerHTML = `
    <div class="album__cover">
      <img src="${esc(coverSrc(s))}" alt="${esc(singleArtistText(s))} — ${esc(title)}" loading="lazy">
      <span class="album__year">${s.year}</span>
      <span class="album__badge">сингл</span>
    </div>
    <div class="album__body">
      <h3 class="album__title">${esc(title)}</h3>
      <p class="album__artist">${singleArtistHTML(s, 'album__artist-link')}</p>
      ${parent ? `<div class="album__parent">${parentLinksHtml(s)}</div>` : ''}
      <div class="album__rating">
        <div class="album__avg">
          <span class="album__avg-num">${avg === null ? '—' : fmt(avg)}</span>
          <span class="album__avg-of">/10</span>
        </div>
        <div class="album__votes">
          <span class="album__count">${votes} ${votesPlural(votes)}</span>
          ${pending ? `<span class="album__votes-count">${pending} без подтверждения</span>` : ''}
        </div>
      </div>
    </div>`;
  el.addEventListener('click', (ev) => {
    if (handleParentClick(ev)) return;
    if ((ev.target as HTMLElement).closest('.album__artist-link')) return; // клик по артисту
    void openSingle(s.id);
  });
  if (animate) {
    el.addEventListener('animationend', () => {
      if (el.classList.contains('reveal')) {
        el.classList.remove('reveal');
        el.style.animation = 'none';
      }
    });
  }
  return el;
}

/* компактная строка-карточка сингла (страница альбома) */
function makeSingleRow(s: UiAlbum): HTMLElement {
  const el = document.createElement('button');
  el.type = 'button';
  el.className = 'scard';
  const avg = singleScoreOf(s.id);
  const votes = singleVotesOf(s.id);
  el.innerHTML = `
    <span class="scard__cover"><img src="${esc(coverSrc(s))}" alt="" loading="lazy"></span>
    <span class="scard__body">
      <span class="scard__title">${esc(singleDisplayTitle(s))}</span>
      <span class="scard__meta">${s.year} · ${votes} ${votesPlural(votes)}</span>
    </span>
    <span class="scard__score">${avg === null ? '—' : fmt(avg)}</span>`;
  el.addEventListener('click', () => void openSingle(s.id));
  return el;
}

function renderArtistPage(): void {
  const name = currentArtistName ?? '';
  artistName.textContent = name;
  const sc = artistScoreOf(name);
  artistScore.textContent = sc === null ? '—' : fmt(sc);

  const own = artistOwnAlbums(name);
  artistOwnSection.hidden = own.length === 0;
  artistOwn.innerHTML = '';
  for (const a of own) artistOwn.appendChild(makeAlbumCard(a));

  /* Синглы — все релизы артиста такого типа: и сольные, и с фитом/совместкой
     («Название & Гость»). Гость видит сингл здесь же, а не в «при участии»:
     раздел «при участии» оставлен за альбомами с его фит-треками. */
  const ownSingles = artistOwnSingles(name);
  const featSingles = artistFeatureSingles(name);
  artistSinglesSection.hidden = ownSingles.length === 0 && featSingles.length === 0;
  artistSingles.innerHTML = '';
  for (const s of ownSingles) artistSingles.appendChild(makeAlbumCard(s));
  for (const f of featSingles) artistSingles.appendChild(makeAlbumCard(f.single));

  const feats = artistFeatureAlbums(name);
  artistFeatSection.hidden = feats.length === 0;
  artistFeat.innerHTML = '';
  for (const f of feats) artistFeat.appendChild(makeAlbumCard(f.album, f.score));
}

/* --- рейтинг артистов --- */
interface ArtistRank { name: string; score: number | null; ownCount: number; featCount: number; cover: string; }

/* Обложка в рейтинге артистов — с ЛУЧШЕЙ работы, а не только лучшего альбома:
   сначала свои альбомы и синглы, затем (если своих релизов нет) альбомы, где
   артист участвует на фите, и в последнюю очередь синглы с его участием.
   Внутри группы берётся работа с самым высоким баллом, но если у неё нет своей
   картинки — следующая по баллу работа с настоящей обложкой: пустой плитки
   с буквой и тем более пустого <img> в рейтинге не остаётся. */
function artistRankCover(name: string): string {
  const groups: Array<Array<{ release: UiAlbum; score: number | null }>> = [
    [
      ...artistOwnAlbums(name).map((a) => ({ release: a, score: albumScoreOf(a.id) })),
      ...artistOwnSingles(name).map((s) => ({ release: s, score: singleScoreOf(s.id) })),
    ],
    artistFeatureAlbums(name).map((f) => ({ release: f.album, score: f.score })),
    artistFeatureSingles(name).map((f) => ({ release: f.single, score: singleScoreOf(f.single.id) })),
  ];
  for (const group of groups) {
    if (!group.length) continue;
    const sorted = [...group].sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
    const withArt = sorted.find((c) => hasCoverArt(c.release));
    return coverSrc((withArt ?? sorted[0]).release);
  }
  return letterCover(name);
}

function artistRanks(): ArtistRank[] {
  return allArtistNames().map((name) => {
    const own = artistOwnAlbums(name);
    const feats = artistFeatureAlbums(name);
    return {
      name,
      score: artistScoreOf(name),
      ownCount: own.length,
      featCount: feats.length,
      cover: artistRankCover(name),
    };
  }).sort((a, b) => {
    if (a.score === null && b.score === null) return a.name.localeCompare(b.name, 'ru');
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || a.name.localeCompare(b.name, 'ru');
  });
}

function renderArtistRank(): void {
  rankList.innerHTML = '';
  artistRanks().forEach((r, i) => {
    const pos = i + 1;
    const li = document.createElement('li');
    li.className = 'rank' + (pos <= 3 ? ` rank--${pos}` : '');
    const meta: string[] = [];
    if (r.ownCount) meta.push(`${r.ownCount} ${plural(r.ownCount)}`);
    if (r.featCount) meta.push(`${r.featCount} ${featPlural(r.featCount)}`);
    li.innerHTML = `
      <span class="rank__pos">${pos}</span>
      <span class="rank__ava"><img src="${esc(r.cover)}" alt="" loading="lazy"></span>
      <div class="rank__body">
        <span class="rank__name">${esc(r.name)}</span>
        <span class="rank__meta">${meta.join(' · ') || 'без альбомов'}</span>
      </div>
      <span class="rank__score">${r.score === null ? '—' : fmt(r.score)}</span>`;
    li.addEventListener('click', () => void openArtist(r.name));
    rankList.appendChild(li);
  });
}

async function openArtists(): Promise<void> {
  renderArtistRank();
  await navigateTo(viewRank, { view: 'rank' });
}

/* --- рейтинг альбомов: строгий принцип, как у синглов и треков —
   в чарт попадает альбом, где каждый трек подтверждён всеми участниками --- */
interface AlbumRank { album: UiAlbum; score: number | null; votes: number; }

function albumVotesOf(albumId: string): number {
  let n = 0;
  for (const t of tracks) {
    if (t.albumId !== albumId) continue;
    const r = trackRatings[t.id];
    if (r) n += Object.keys(r).length;
  }
  return n;
}

function albumRankedScoreOf(albumId: string): number | null {
  return albumAllConfirmed(albumId) ? albumScoreOf(albumId) : null;
}

function albumRanks(): AlbumRank[] {
  return albumsOnly().map((a) => ({
    album: a,
    score: albumRankedScoreOf(a.id),
    votes: albumVotesOf(a.id),
  })).sort((a, b) => {
    const ta = a.album.title;
    const tb = b.album.title;
    if (a.score === null && b.score === null) return ta.localeCompare(tb, 'ru');
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || ta.localeCompare(tb, 'ru');
  });
}

function renderAlbumRank(): void {
  albumRankList.innerHTML = '';
  const list = albumRanks();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'rank__empty';
    li.textContent = 'альбомов пока нет — добавьте первый альбом';
    albumRankList.appendChild(li);
    return;
  }
  list.forEach((r, i) => {
    const pos = i + 1;
    const li = document.createElement('li');
    li.className = 'rank' + (pos <= 3 && r.score !== null ? ` rank--${pos}` : '') + (r.score === null ? ' is-unranked' : '');
    const n = trackCountOf(r.album.id);
    const meta: string[] = [r.album.artist, String(r.album.year), `${n} ${tracksPlural(n)}`];
    if (r.score === null) meta.push(r.votes === 0 ? 'оценок пока нет' : 'ждём подтверждения всех оценок');
    li.innerHTML = `
      <span class="rank__pos">${pos}</span>
      <span class="rank__ava"><img src="${esc(coverSrc(r.album))}" alt="" loading="lazy"></span>
      <div class="rank__body">
        <span class="rank__name">${esc(r.album.title)}</span>
        <span class="rank__meta">${esc(meta.join(' · '))}</span>
      </div>
      <span class="rank__score">${r.score === null ? '—' : fmt(r.score)}</span>`;
    li.addEventListener('click', () => void openAlbum(r.album.id));
    albumRankList.appendChild(li);
  });
}

async function openAlbumRank(): Promise<void> {
  renderAlbumRank();
  await navigateTo(viewArank, { view: 'arank' });
}

/* Меню «рейтинги» в шапке: альбомы / артисты / синглы / все треки. */
function updateRankMenuCounts(): void {
  const find = (k: string) => rankMenuList.querySelector<HTMLElement>(`.rank-menu__count[data-count="${k}"]`);
  const albumsEl = find('albums');
  if (albumsEl) albumsEl.textContent = String(albumsOnly().length);
  const artists = find('artists');
  if (artists) artists.textContent = String(allArtistNames().length);
  const singles = find('singles');
  if (singles) singles.textContent = String(singlesOnly().length);
  const tracksEl = find('tracks');
  if (tracksEl) tracksEl.textContent = String(trackRanks().length);
}

function setRankMenu(open: boolean): void {
  if (open) updateRankMenuCounts();
  rankMenuList.hidden = !open;
  artistsBtn.setAttribute('aria-expanded', String(open));
  artistsBtn.classList.toggle('is-open', open);
}
artistsBtn.addEventListener('click', (e) => {
  e.stopPropagation();
  setRankMenu(rankMenuList.hidden);
});
document.addEventListener('click', (e) => {
  if (rankMenu.contains(e.target as Node)) return;
  setRankMenu(false);
});
/* тач: тап вне списка треков снимает выделение строки */
document.addEventListener('click', (e) => {
  if (!TOUCH_UI.matches || !activeTrackId) return;
  if (!trackList.contains(e.target as Node)) setActiveTrack(null);
});
rankMenuList.addEventListener('click', (e) => {
  const item = (e.target as HTMLElement).closest<HTMLButtonElement>('.rank-menu__item');
  if (!item) return;
  setRankMenu(false);
  if (item.dataset.rank === 'albums') void openAlbumRank();
  else if (item.dataset.rank === 'artists') void openArtists();
  else if (item.dataset.rank === 'singles') void openSingleRank();
  else if (item.dataset.rank === 'tracks') void openTrackRank();
});
rankBack.addEventListener('click', () => void goBack());
arankBack.addEventListener('click', () => void goBack());
srankBack.addEventListener('click', () => void goBack());
trankBack.addEventListener('click', () => void goBack());

/* --- рейтинг синглов: только подтверждённые оценки --- */
interface SingleRank { single: UiAlbum; score: number | null; votes: number; pending: number; }

function singleRanks(): SingleRank[] {
  return singlesOnly()
    .map((s) => ({
      single: s,
      score: singleRankedScoreOf(s.id),
      votes: singleVotesOf(s.id),
      pending: pendingCountOf(s.id),
    }))
    .sort((a, b) => {
      const ta = singleDisplayTitle(a.single);
      const tb = singleDisplayTitle(b.single);
      if (a.score === null && b.score === null) return ta.localeCompare(tb, 'ru');
      if (a.score === null) return 1;
      if (b.score === null) return -1;
      return b.score - a.score || ta.localeCompare(tb, 'ru');
    });
}

function renderSingleRank(): void {
  singleRankList.innerHTML = '';
  const list = singleRanks();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'rank__empty';
    li.textContent = 'синглов пока нет — отметьте трек на странице альбома или добавьте сингл кнопкой на главной';
    singleRankList.appendChild(li);
    return;
  }
  list.forEach((r, i) => {
    const pos = i + 1;
    const li = document.createElement('li');
    li.className = 'rank' + (pos <= 3 && r.score !== null ? ` rank--${pos}` : '') + (r.score === null ? ' is-unranked' : '');
    const parent = parentOf(r.single);
    const meta: string[] = [String(r.single.year), singleArtistText(r.single)];
    /* Привязку показываем, только если она есть: «вне альбома» в рейтинге — лишний шум. */
    if (parent) meta.push(`к альбому «${parent.title}»`);
    if (r.score === null) meta.push(singleRankReason(r.single.id));
    li.innerHTML = `
      <span class="rank__pos">${pos}</span>
      <span class="rank__ava"><img src="${esc(coverSrc(r.single))}" alt="" loading="lazy"></span>
      <div class="rank__body">
        <span class="rank__name">${esc(singleDisplayTitle(r.single))}</span>
        <span class="rank__meta">${esc(meta.join(' · '))}</span>
      </div>
      <span class="rank__score">${r.score === null ? '—' : fmt(r.score)}</span>`;
    li.addEventListener('click', () => void openSingle(r.single.id));
    singleRankList.appendChild(li);
  });
}

async function openSingleRank(): Promise<void> {
  renderSingleRank();
  await navigateTo(viewSrank, { view: 'rank' });
}

/* --- рейтинг треков: треки альбомов и синглы вместе --- */
interface TrackRankEntry {
  kind: 'track' | 'single';
  track?: UiTrack;
  album?: UiAlbum;
  single?: UiAlbum;
  score: number | null;
  name: string;
}

function trackVotesOf(trackId: string): number {
  const r = trackRatings[trackId];
  return r ? Object.keys(r).length : 0;
}

/* Все требуемые оценки трека подтверждены — трек попадает в рейтинг. */
function trackAllConfirmed(trackId: string): boolean {
  const release = trackRelease(trackId);
  return Boolean(release && allRatingsConfirmed(release, profileCache.keys(), [trackRatings[trackId]]));
}

function trackRankedScoreOf(trackId: string): number | null {
  return trackAllConfirmed(trackId) ? trackScoreOf(trackId) : null;
}

function trackRankReason(trackId: string): string {
  return trackVotesOf(trackId) === 0 ? 'оценок пока нет' : 'ждём подтверждения всех оценок';
}

function trackRanks(): TrackRankEntry[] {
  const out: TrackRankEntry[] = [];
  for (const a of albumsOnly()) {
    for (const t of tracks) {
      if (t.albumId !== a.id) continue;
      // трек, отмеченный синглом, представлен своей карточкой сингла — без дубля
      if (t.singleId && singleById(t.singleId)) continue;
      out.push({
        kind: 'track',
        track: t,
        album: a,
        score: trackRankedScoreOf(t.id),
        name: stripFeat(t.title).trim() || t.title,
      });
    }
  }
  for (const s of singlesOnly()) {
    out.push({ kind: 'single', single: s, score: singleRankedScoreOf(s.id), name: singleDisplayTitle(s) });
  }
  return out.sort((a, b) => {
    if (a.score === null && b.score === null) return a.name.localeCompare(b.name, 'ru');
    if (a.score === null) return 1;
    if (b.score === null) return -1;
    return b.score - a.score || a.name.localeCompare(b.name, 'ru');
  });
}

function renderTrackRank(): void {
  trackRankList.innerHTML = '';
  const list = trackRanks();
  if (!list.length) {
    const li = document.createElement('li');
    li.className = 'rank__empty';
    li.textContent = 'треков пока нет — добавьте альбом с треками или сингл';
    trackRankList.appendChild(li);
    return;
  }
  list.forEach((r, i) => {
    const pos = i + 1;
    const li = document.createElement('li');
    li.className = 'rank' + (pos <= 3 && r.score !== null ? ` rank--${pos}` : '') + (r.score === null ? ' is-unranked' : '');
    let cover = '';
    let artistText = '';
    let meta = '';
    if (r.kind === 'track') {
      const t = r.track!;
      const a = r.album!;
      cover = coverSrc(a);
      artistText = t.featArtist ? `${a.artist} ft. ${t.featArtist}` : a.artist;
      meta = `№${t.position + 1} · из альбома «${a.title}»`;
    } else {
      const s = r.single!;
      cover = coverSrc(s);
      artistText = singleArtistText(s);
    }
    if (r.score === null) {
      meta = meta
        ? `${meta} · ${r.kind === 'track' ? trackRankReason(r.track!.id) : singleRankReason(r.single!.id)}`
        : (r.kind === 'track' ? trackRankReason(r.track!.id) : singleRankReason(r.single!.id));
    }
    li.innerHTML = `
      <span class="rank__pos">${pos}</span>
      <span class="rank__ava"><img src="${esc(cover)}" alt="" loading="lazy"></span>
      <div class="rank__body">
        <span class="rank__name">${esc(r.name)}</span>
        <span class="rank__meta">${esc(artistText)}${meta ? ` · ${esc(meta)}` : ''}</span>
      </div>
      <span class="rank__score">${r.score === null ? '—' : fmt(r.score)}</span>`;
    li.addEventListener('click', () => {
      if (r.kind === 'track' && r.album) void openAlbum(r.album.id);
      else if (r.kind === 'single' && r.single) void openSingle(r.single.id);
    });
    trackRankList.appendChild(li);
  });
}

async function openTrackRank(): Promise<void> {
  renderTrackRank();
  await navigateTo(viewTrank, { view: 'trank' });
}

async function openArtist(name: string): Promise<void> {
  if (!name) return;
  currentArtistName = name;
  renderArtistPage();
  await navigateTo(viewArtist, { view: 'artist' });
}

artistBack.addEventListener('click', () => void goBack());

avArtist.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.av__artist-link');
  if (!a) return;
  e.preventDefault();
  const name = a.dataset.artist;
  if (name) void openArtist(name);
});

/* переход на артиста с карточки альбома (главная) */
q<HTMLDivElement>('#albums').addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.album__artist-link');
  if (!a) return;
  e.preventDefault();
  const name = a.dataset.artist;
  if (name) void openArtist(name);
});

/* --- мой профиль: аватар + никнейм --- */
function renderProfilePage(): void {
  if (!currentUser) return;
  setAvatarEl(profAvatar, currentUser);
  profName.value = currentUser.username;
  profRemove.hidden = !currentUser.avatarUrl;
  profError.textContent = '';
  profError.classList.remove('is-visible');
}

async function openProfile(): Promise<void> {
  renderProfilePage();
  await navigateTo(viewProfile, { view: 'profile' });
}

profileBtn.addEventListener('click', () => void openProfile());
profileBack.addEventListener('click', () => void goBack());

/* применяем обновлённые аватар/ник во всех видимых местах */
function applyProfileToUi(): void {
  setAvatarEl(homeAvatar, currentUser);
  setAvatarEl(profAvatar, currentUser);
  profRemove.hidden = !currentUser?.avatarUrl;
  if (viewHome.classList.contains('is-visible')) renderAlbums();
  if (currentAlbumId && viewAlbum.classList.contains('is-visible')) { renderTracks(); updateRatingDisplays(); }
  if (currentArtistName && viewArtist.classList.contains('is-visible')) renderArtistPage();
}

profUpload.addEventListener('click', () => profFile.click());
profFile.addEventListener('change', () => {
  const f = profFile.files?.[0];
  if (f) void handleAvatarFile(f);
});

async function handleAvatarFile(file: File): Promise<void> {
  if (!file.type.startsWith('image/')) { toast('Нужен файл изображения'); return; }
  try {
    const dataUrl = await readFileAsDataURL(file);
    const img = await loadImage(dataUrl);
    const max = 320;
    const scale = Math.min(1, max / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    await saveAvatar(canvas.toDataURL('image/jpeg', 0.85));
    toast('Аватар обновлён');
  } catch {
    toast('Не удалось прочитать изображение');
  }
}

async function saveAvatar(dataUrl: string | null): Promise<void> {
  if (!currentUser) return;
  let url: string | null = dataUrl;
  if (CLOUD && dataUrl) {
    const blob = dataUrlToBlob(dataUrl);
    const path = 'avatar-' + currentUser.id.replace(/[^a-z0-9]/gi, '').slice(0, 12) + '-' + Date.now().toString(36) + '.jpg';
    const up = await getSB().storage.from('covers').upload(path, blob, { contentType: 'image/jpeg', upsert: true });
    if (up.error) throw up.error;
    const { data } = getSB().storage.from('covers').getPublicUrl(path);
    url = data.publicUrl;
  } else if (!CLOUD) {
    const meta = loadLocalMeta();
    const key = currentUser.email.toLowerCase();
    const m = meta[key] ?? { username: currentUser.username, avatarUrl: null };
    m.avatarUrl = dataUrl;
    meta[key] = m;
    saveLocalMeta(meta);
  }
  if (CLOUD) {
    const { error } = await getSB().from('profiles').update({ avatar_url: url }).eq('id', currentUser.id);
    if (error) throw error;
  }
  currentUser.avatarUrl = url;
  const cached = profileCache.get(currentUser.id);
  if (cached) cached.avatarUrl = url;
  applyProfileToUi();
}

profRemove.addEventListener('click', () => void saveAvatar(null));

async function saveNickname(): Promise<void> {
  if (!currentUser) return;
  const name = profName.value.trim();
  profError.textContent = '';
  profError.classList.remove('is-visible');
  if (!name) { profError.textContent = 'Введите ник'; profError.classList.add('is-visible'); return; }
  try {
    if (CLOUD) {
      const { error } = await getSB().from('profiles').update({ username: name }).eq('id', currentUser.id);
      if (error) throw error;
    } else {
      const meta = loadLocalMeta();
      const key = currentUser.email.toLowerCase();
      const m = meta[key] ?? { username: currentUser.username, avatarUrl: currentUser.avatarUrl };
      m.username = name;
      meta[key] = m;
      saveLocalMeta(meta);
    }
    currentUser.username = name;
    const cached = profileCache.get(currentUser.id);
    if (cached) cached.username = name;
    homeTitle.textContent = name;
    applyProfileToUi();
    toast('Никнейм сохранён');
  } catch (err) {
    const code = (err as { code?: string } | null)?.code;
    profError.textContent = code === '23505' ? 'этот ник уже занят' : messageOf(err);
    profError.classList.add('is-visible');
  }
}

profSave.addEventListener('click', () => void saveNickname());

/* --- удаление альбома --- */
albumDeleteBtn.addEventListener('click', () => void handleDeleteAlbum());

async function handleDeleteAlbum(): Promise<void> {
  const al = currentAlbum();
  if (!al || !currentAlbumId) return;
  const ok = await openConfirm(
    'Удалить альбом?',
    `Альбом <b>«${esc(al.title)}»</b> — ${esc(al.artist)} будет удалён <b>навсегда</b> вместе со всеми треками и оценками. Это действие нельзя отменить.`,
    true,
  );
  if (!ok) return;
  try {
    if (CLOUD) {
      const ids = tracks.filter((t) => t.albumId === al.id).map((t) => t.id);
      if (ids.length) await getSB().from('ratings').delete().in('track_id', ids);
      await getSB().from('tracks').delete().eq('album_id', al.id);
      await getSB().from('albums').delete().eq('id', al.id);
    } else {
      const deadIds = new Set(tracks.filter((t) => t.albumId === al.id).map((t) => t.id));
      // Синглы не удаляются: убирается только этот альбом (в облаке — SQL-триггер).
      albums = albums
        .filter((a) => a.id !== al.id)
        .map((a) => {
          if (a.kind !== 'single') return a;
          const parentIds = parentIdsOf(a).filter((id) => id !== al.id);
          return { ...a, parentIds, parentId: parentIds[0] ?? null };
        });
      tracks = tracks.filter((t) => t.albumId !== al.id);
      for (const id of deadIds) delete trackRatings[id];
      saveLocalAlbums();
      saveLocalTracks();
      saveLocalRatings();
    }
    const wasLast = currentAlbumId === al.id;
    currentAlbumId = null;
    viewStack.length = 0;
    viewStack.push({ view: 'home' });
    if (wasLast) {
      await crumbleCover();
      renderAlbums();
      await swapTo(viewAlbum, viewHome, () => { viewHome.scrollTop = 0; });
    }
    toast('Альбом удалён');
  } catch (err) {
    toast(messageOf(err));
  }
}

/* осыпание обложки: карточка распадается на кусочки, которые
   разлетаются вниз с вращением и тают — перед уходом со страницы */
async function crumbleCover(selector = '.av__cover'): Promise<void> {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cover = document.querySelector<HTMLElement>(selector);
  if (!cover) return;
  const img = cover.querySelector<HTMLImageElement>('img');
  const src = img?.getAttribute('src');
  const rect = cover.getBoundingClientRect();
  if (!src || rect.width < 4 || rect.height < 4) return;

  if (img) img.style.opacity = '0';

  const COLS = 12;
  const ROWS = 12;
  const pw = rect.width / COLS;
  const ph = rect.height / ROWS;
  const safeSrc = src.replace(/"/g, '%22');

  const layer = document.createElement('div');
  layer.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;z-index:60;pointer-events:none;`;
  document.body.appendChild(layer);

  const frags: HTMLElement[] = [];
  const targets: Array<{ dx: number; dy: number; rot: number; delay: number; dur: number }> = [];

  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++) {
      const f = document.createElement('div');
      f.className = 'crumble-frag';
      f.style.left = `${c * pw}px`;
      f.style.top = `${r * ph}px`;
      f.style.width = `${pw + 0.5}px`;
      f.style.height = `${ph + 0.5}px`;
      f.style.backgroundImage = `url("${safeSrc}")`;
      f.style.backgroundSize = `${rect.width}px ${rect.height}px`;
      f.style.backgroundPosition = `${-(c * pw)}px ${-(r * ph)}px`;
      const dx = (Math.random() - 0.5) * rect.width * 0.55;
      const dy = rect.height * (0.35 + Math.random() * 1.05) + Math.random() * 140;
      const rot = (Math.random() - 0.5) * 150;
      const delay = Math.random() * 0.16 + (r / ROWS) * 0.12;
      const dur = 0.5 + Math.random() * 0.45;
      f.style.transition = `transform ${dur}s cubic-bezier(0.33, 0, 0.6, 1) ${delay}s, opacity ${dur}s ease ${delay}s`;
      layer.appendChild(f);
      frags.push(f);
      targets.push({ dx, dy, rot, delay, dur });
    }
  }

  await sleep(30);
  frags.forEach((f, i) => {
    const t = targets[i];
    f.style.transform = `translate(${t.dx}px, ${t.dy}px) rotate(${t.rot}deg)`;
    f.style.opacity = '0';
  });

  const maxT = targets.reduce((m, t) => Math.max(m, t.delay + t.dur), 0);
  await sleep(maxT * 1000 + 80);
  layer.remove();
}

/* ==========================================================================
   СИНГЛЫ: страница сингла, метки на треках, привязка к альбому
   ========================================================================== */

function currentSingle(): UiAlbum | undefined {
  return currentSingleId ? singleById(currentSingleId) : undefined;
}

function renderSingleCover(s: UiAlbum): void {
  const src = coverSrc(s);
  if (svCoverImg.getAttribute('src') !== src) svCoverImg.src = src;
  svCoverImg.alt = releaseFullName(s);
  svCoverImg.style.opacity = ''; // сброс после анимации осыпания
  svCoverEdit.hidden = !currentUser;
  const parent = parentOf(s);
  svCoverEditLabel.textContent = s.cover
    ? 'изменить обложку'
    : parent ? 'своя обложка' : 'добавить обложку';
}

/** Считаем именно альбомы с отмеченными треками, а не количество меток. */
function singleOriginText(s: UiAlbum): string {
  const albumIds = new Set(albumsOnly().map((a) => a.id));
  const count = new Set(tracks
    .filter((t) => t.singleId === s.id && albumIds.has(t.albumId))
    .map((t) => t.albumId)).size;
  if (!count) return '';
  const singular = count % 10 === 1 && count % 100 !== 11;
  return `Отмечен синглом в ${count} ${singular ? 'альбоме' : 'альбомах'}`;
}

/** На карточке — только первый альбом. На странице сингла остальные раскрываются в той же строке. */
function parentLinksHtml(s: UiAlbum, onPage = false): string {
  const parents = parentsOf(s);
  if (!parents.length) return onPage ? 'сингл вне альбома' : '';
  const link = (a: UiAlbum) => `<a href="#album-${encodeURIComponent(a.id)}" class="sv__parent-link" data-album="${esc(a.id)}">«${esc(a.title)}»</a>`;
  const first = `${onPage ? 'сингл ' : ''}к альбому ${link(parents[0])}`;
  if (!onPage || parents.length === 1) return first;
  const extra = parents.slice(1).map((a, i) => `${i === parents.length - 2 ? ' и ' : ', '}${link(a)}`).join('');
  return `<span class="parent-intro">сингл к альбому</span> ${link(parents[0])}<span class="parent-disclosure"><span class="parent-list" hidden>${extra}</span><span class="parent-control-space" aria-hidden="true"> </span><button type="button" class="parent-more" aria-expanded="false">показать еще...</button></span>`;
}

function renderSingleParents(s: UiAlbum): void {
  const html = parentLinksHtml(s, true);
  // Фоновая синхронизация не сворачивает раскрытый пользователем список.
  if (svParentLabel.dataset.content !== html) {
    svParentLabel.innerHTML = html;
    svParentLabel.dataset.content = html;
  }
  svParentEdit.textContent = parentsOf(s).length ? 'изменить' : 'привязать к альбому';
  // глаз с миниатюрой: показывает обложку первого (основного) альбома
  const parent = parentsOf(s)[0];
  svPeekBtn.hidden = !parent;
  if (parent) {
    if (svPeekImg.getAttribute('src') !== coverSrc(parent)) svPeekImg.src = coverSrc(parent);
    svPeekImg.alt = `${parent.artist} — ${parent.title}`;
    svPeekTitle.textContent = parent.title;
    svPeekArtist.textContent = parent.artist;
  } else {
    hideParentPeek();
  }
}

type ParentTransition = { animations: Animation[] };
const parentTransitions = new WeakMap<HTMLButtonElement, ParentTransition>();

async function toggleSingleParents(more: HTMLButtonElement): Promise<void> {
  parentTransitions.get(more)?.animations.forEach((animation) => animation.cancel());
  const transition: ParentTransition = { animations: [] };
  parentTransitions.set(more, transition);
  const expanded = more.getAttribute('aria-expanded') !== 'true';
  more.setAttribute('aria-expanded', String(expanded));
  const list = more.parentElement!.querySelector<HTMLElement>('.parent-list')!;
  const intro = svParentLabel.querySelector<HTMLElement>('.parent-intro')!;
  const row = svParentLabel.parentElement!;
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const animate = (el: HTMLElement, frames: Keyframe[], duration = 220): Animation => {
    const animation = el.animate(frames, { duration, easing: 'cubic-bezier(.22, 1, .36, 1)' });
    transition.animations.push(animation);
    return animation;
  };
  // Сворачивание заметно шустрее открытия, чтобы «скрыть» не ощущалось медленнее:
  // гашение ссылок 70 мс + высота/кнопки 140 мс ≈ так же быстро, как открытие (220 мс).
  const phase = expanded ? 220 : 140;

  // При сворачивании сначала гасим ссылки; только затем убираем их из строки.
  if (!expanded && !reduce) {
    await animate(list, [{ opacity: 1 }, { opacity: 0 }], 70).finished.catch(() => {});
    if (parentTransitions.get(more) !== transition || !more.isConnected) return;
  }
  const beforeHeight = row.getBoundingClientRect().height;
  const controls = [more, svParentEdit];
  const beforePositions = controls.map((el) => el.getBoundingClientRect());
  list.hidden = !expanded;
  intro.textContent = expanded ? 'сингл к альбомам' : 'сингл к альбому';
  more.textContent = expanded ? 'скрыть' : 'показать еще...';

  if (!reduce) {
    if (expanded) animate(list, [{ opacity: 0 }, { opacity: 1 }]);
    const afterHeight = row.getBoundingClientRect().height;
    // При переносе длинного списка нижние блоки тоже перемещаются плавно.
    if (Math.abs(afterHeight - beforeHeight) > 1) {
      animate(row, [{ height: `${beforeHeight}px` }, { height: `${afterHeight}px` }], phase);
    }
    controls.forEach((el, i) => {
      const after = el.getBoundingClientRect();
      const before = beforePositions[i];
      animate(el, [
        { transform: `translate(${before.x - after.x}px, ${before.y - after.y}px)`, opacity: 0.65 },
        { transform: 'translate(0, 0)', opacity: 1 },
      ], phase);
    });
    await Promise.all(transition.animations.map((animation) => animation.finished.catch(() => {})));
  }
  if (parentTransitions.get(more) === transition) parentTransitions.delete(more);
}

function handleParentClick(e: MouseEvent): boolean {
  const target = e.target as HTMLElement;
  const more = target.closest<HTMLButtonElement>('.parent-more');
  if (more) {
    void toggleSingleParents(more);
  } else {
    const link = target.closest<HTMLAnchorElement>('.sv__parent-link');
    if (!link) return false;
    if (link.dataset.album) void openAlbum(link.dataset.album);
  }
  e.preventDefault();
  e.stopPropagation();
  return true;
}

function renderSinglePage(s: UiAlbum): void {
  renderEvaluator(s, '#sv-evaluator');
  svTitle.textContent = singleDisplayTitle(s);
  svArtist.innerHTML = singleArtistHTML(s, 'sv__artist-link');
  svYear.textContent = String(s.year);
  renderSingleCover(s);

  renderSingleParents(s);

  const origin = singleOriginText(s);
  svOrigin.hidden = !origin;
  svOrigin.textContent = origin;

  const score = singleScoreOf(s.id);
  svAvg.textContent = score === null ? '—' : fmt(score);
  delete svAvg.dataset.val;

  updateSingleDisplays();
  svNote.textContent = singlesUnavailable()
    ? 'раздел синглов не подключён к базе: выполните migrate.sql в Supabase'
    : !canEvaluate(s, currentUser?.id) ? 'Этот сингл оценивает назначенный участник. Его оценка видна вам на этой странице.'
    : 'передвиньте ползунок или введите число, затем подтвердите — до подтверждения балл не влияет на рейтинг';
}

function updateSingleDisplays(): void {
  const s = currentSingle();
  if (!s) return;
  tweenText(svAvg, singleScoreOf(s.id));
  renderSingleConfirmState();
  renderSingleImpact();
  renderSingleMine();
  syncSingleControls();
}

function renderSingleConfirmState(): void {
  const s = currentSingle();
  if (!s || singleScoreOf(s.id) === null) {
    svConfirmState.hidden = true;
    return;
  }
  const final = singleAllConfirmed(s.id);
  svConfirmState.hidden = false;
  svConfirmState.classList.toggle('is-final', final);
  svConfirmState.innerHTML = final
    ? `${CHECK_SVG}<span>подтверждён</span>`
    : `${PENDING_SVG}<span>не подтверждён</span>`;
}

/* вклад участников: у сингла одна оценка на человека */
function renderSingleImpact(): void {
  const s = currentSingle();
  svChips.innerHTML = '';
  if (!s) { svImpact.hidden = true; return; }
  const r = singleRatings[s.id];
  if (!r || !Object.keys(r).length) { svImpact.hidden = true; return; }
  svImpact.hidden = false;

  const rows = [...profileCache].filter(([pid]) => requiredEvaluators(s, profileCache.keys()).includes(pid)).map(([pid, info]) => ({
    id: pid, username: info.username, initials: info.initials, avatarUrl: info.avatarUrl,
    value: r[pid] ?? null,
  }));
  rows.sort((a, b) => Number(b.id === currentUser?.id) - Number(a.id === currentUser?.id));

  for (const row of rows) {
    const isMe = row.id === currentUser?.id;
    const chip = document.createElement('div');
    chip.className = 'av__chip' + (isMe ? ' is-me' : '');
    const label = isMe ? 'я' : esc(row.username);
    const state = row.value ? (row.value.confirmed ? 'подтверждено' : 'без подтверждения') : 'нет оценки';
    chip.innerHTML = `
      ${avatarMarkup(row, 'av__chip-who')}
      <span class="av__chip-val">${row.value ? fmt(row.value.score) : '—'}</span>
      <span class="av__chip-sub">${label} · ${state}</span>`;
    chip.title = `${row.username}: ${row.value ? fmt(row.value.score) : 'нет оценки'} · ${state}`;
    svChips.appendChild(chip);
  }
}

/* --- моя оценка сингла --- */
let singlePointerActive = false;
const singleSaveTimers = new Map<string, number>();
const singleWrites = new Map<string, Promise<void>>();

function setSingleSave(state: 'save' | 'done' | 'err' | ''): void {
  const map: Record<string, string> = { save: 'сохраняю…', done: 'сохранено', err: 'ошибка', '': '' };
  svSave.textContent = map[state];
  svSave.classList.toggle('is-visible', state !== '');
  if (state === 'done') {
    window.setTimeout(() => {
      if (svSave.textContent === 'сохранено') svSave.classList.remove('is-visible');
    }, 1600);
  }
}

function peerSingleRatingOf(singleId: string): { score: number; confirmed: boolean; username: string; initials: string; avatarUrl: string | null } | null {
  if (!currentUser) return null;
  const r = singleRatings[singleId];
  if (!r) return null;
  for (const [pid, v] of Object.entries(r)) {
    if (pid === currentUser.id) continue;
    const info = profileCache.get(pid);
    return {
      score: v.score, confirmed: v.confirmed,
      username: info?.username ?? 'участник', initials: info?.initials ?? '?', avatarUrl: info?.avatarUrl ?? null,
    };
  }
  return null;
}

function renderSingleMine(): void {
  const s = currentSingle();
  const mine = currentUser && s ? singleRatings[s.id]?.[currentUser.id] : undefined;
  svMine.textContent = mine ? fmt(mine.score) : '—';
  svMine.classList.toggle('is-empty', !mine);
}

function syncSingleControls(): void {
  const s = currentSingle();
  const myId = currentUser?.id;
  if (!s || !myId) return;
  const mine = singleRatings[s.id]?.[myId];
  const editing = document.activeElement === svSlider || document.activeElement === svNum || singlePointerActive;
  if (!editing) {
    svSlider.value = String(mine?.score ?? 5);
    svNum.value = mine ? fmt(mine.score) : '';
  }
  const confirmed = mine?.confirmed === true;
  const permitted = canEvaluate(s, currentUser?.id);
  q<HTMLElement>('.sv__rate-label').textContent = permitted ? 'моя оценка' : 'без права оценки';
  svSlider.disabled = confirmed || !permitted;
  svNum.disabled = confirmed || !permitted;
  svConfirmBtn.disabled = !mine || !permitted;
  setConfirmIcon(svConfirmBtn, confirmed);
  const label = confirmed ? 'Изменить оценку' : 'Подтвердить оценку';
  svConfirmBtn.title = label;
  svConfirmBtn.setAttribute('aria-label', label);
  svSlider.classList.toggle('is-locked', confirmed);
  svNum.classList.toggle('is-locked', confirmed);
  renderSingleMine();

  const peer = peerSingleRatingOf(s.id);
  svPeer.innerHTML = peer?.confirmed
    ? `<span class="track__peer" title="оценка ${esc(peer.username)} · подтверждена">
         ${avatarMarkup(peer, 'track__peer-who')}
         <span class="track__peer-val">${fmt(peer.score)}</span>
       </span>`
    : '';
}

function setSingleRating(v: number): void {
  const s = currentSingle();
  if (!s || !currentUser || !canEvaluate(s, currentUser.id)) return;
  const prev = singleRatings[s.id]?.[currentUser.id];
  (singleRatings[s.id] ??= {})[currentUser.id] = { score: v, confirmed: prev?.confirmed === true };
  if (!CLOUD) saveLocalSingleRatings();
  setSingleSave('save');
  updateSingleDisplays();
  scheduleSingleSave(s.id);
}

function clearSingleRating(): void {
  const s = currentSingle();
  if (!s || !currentUser || !canEvaluate(s, currentUser.id)) return;
  const r = singleRatings[s.id];
  if (r) {
    delete r[currentUser.id];
    if (!Object.keys(r).length) delete singleRatings[s.id];
  }
  if (!CLOUD) saveLocalSingleRatings();
  setSingleSave('save');
  updateSingleDisplays();
  scheduleSingleSave(s.id);
}

function stageSingleSave(singleId: string): PendingRating {
  const value = currentUser ? singleRatings[singleId]?.[currentUser.id] : null;
  const pending: PendingRating = { value: value ? { ...value } : null };
  pendingSingleRatings.set(singleId, pending);
  return pending;
}

/** Запускает отложенную запись сингла, не трогая «соседнее» хранилище трека. */
function armSingleSave(singleId: string): void {
  window.clearTimeout(singleSaveTimers.get(singleId));
  singleSaveTimers.set(singleId, window.setTimeout(() => {
    singleSaveTimers.delete(singleId);
    void persistSingleRating(singleId).catch((err) => toast(messageOf(err)));
  }, 500));
}

function scheduleSingleSave(singleId: string): void {
  stageSingleSave(singleId);
  mirrorSingleToTracks(singleId);
  armSingleSave(singleId);
}

/* --- Трек-сингл и релиз-сингл делят одну оценку ---
   На альбоме трек с меткой «сингл» выглядит как трек, а на странице сингла — как релиз
   целиком. Чтобы это была одна и та же оценка, стороны пишут и читают согласованно:
   при чтении данные сводятся вместе (оценка сингла главнее), а правка балла или
   подтверждения с любой стороны уезжает в обе таблицы — ratings и single_ratings. */

/** Идентификатор сингла, к которому привязан трек (null — обычный трек). */
function singleIdOfTrack(trackId: string): string | null {
  return tracks.find((t) => t.id === trackId)?.singleId ?? null;
}

/** Треки, отмеченные как этот сингл. */
function tracksOfSingle(singleId: string): UiTrack[] {
  return tracks.filter((t) => t.singleId === singleId);
}

/** Кладёт общую оценку в хранилище: есть значение — ставим, нет — убираем строку профиля. */
function setSharedRating(store: RatingMap, id: string, profileId: string, value: TrackRating | undefined): void {
  const map = (store[id] ??= {});
  if (value) map[profileId] = { score: value.score, confirmed: value.confirmed };
  else {
    delete map[profileId];
    if (!Object.keys(map).length) delete store[id];
  }
}

/** Свод оценок трека-сингла и релиза-сингла. Оценка сингла главнее оценки трека
    (если синглу балл уже поставлен, он фиксируется и на альбоме), а незаписанные
    правки главнее прочитанного из базы. */
function shareRatingsWithSingles(): void {
  const myId = currentUser?.id;
  for (const t of tracks) {
    const singleId = t.singleId;
    if (!singleId) continue;
    const singleMap = singleRatings[singleId] ?? {};
    const trackMap = trackRatings[t.id] ?? {};
    for (const profileId of new Set([...Object.keys(singleMap), ...Object.keys(trackMap)])) {
      const shared = singleMap[profileId] ?? trackMap[profileId];
      if (!shared) continue;
      (singleRatings[singleId] ??= {})[profileId] = { ...shared };
      (trackRatings[t.id] ??= {})[profileId] = { ...shared };
    }
    if (!myId) continue;
    for (const pending of [pendingRatings.get(t.id), pendingSingleRatings.get(singleId)]) {
      if (!pending || pending.savedAfterRead !== undefined) continue;
      setSharedRating(singleRatings, singleId, myId, pending.value ?? undefined);
      setSharedRating(trackRatings, t.id, myId, pending.value ?? undefined);
    }
  }
}

/** Балл трека уезжает в его сингл: экран сингла и рейтинг синглов показывают то же самое. */
function mirrorTrackToSingle(trackId: string, immediate = false): void {
  const singleId = singleIdOfTrack(trackId);
  if (singleId === null || !currentUser) return;
  setSharedRating(singleRatings, singleId, currentUser.id, trackRatings[trackId]?.[currentUser.id]);
  if (CLOUD) {
    stageSingleSave(singleId);
    if (immediate) void persistSingleRating(singleId).catch((err) => toast(messageOf(err)));
    else armSingleSave(singleId);
  } else saveLocalSingleRatings();
  mirrorSingleToTracks(singleId, immediate, trackId);
  if (currentSingleId === singleId) updateSingleDisplays();
}

/** Обратная сторона: балл сингла ложится на его трек в альбоме. */
function mirrorSingleToTracks(singleId: string, immediate = false, exceptTrackId?: string): void {
  if (!currentUser) return;
  const linked = tracksOfSingle(singleId).filter((t) => t.id !== exceptTrackId);
  if (!linked.length) return;
  const mine = singleRatings[singleId]?.[currentUser.id];
  for (const t of linked) {
    setSharedRating(trackRatings, t.id, currentUser.id, mine);
    if (CLOUD) {
      stageRatingSave(t.id);
      if (immediate) void persistTrackRating(t.id).catch((err) => toast(messageOf(err)));
      else armTrackSave(t.id);
    }
  }
  if (!CLOUD) saveLocalRatings();
  if (currentAlbumId) {
    syncTrackRatingControls();
    updateRatingDisplays();
  }
}

function persistSingleRating(singleId: string): Promise<void> {
  if (!currentUser || !canEvaluate(singleById(singleId), currentUser.id)) return Promise.resolve();
  window.clearTimeout(singleSaveTimers.get(singleId));
  singleSaveTimers.delete(singleId);
  const existing = singleWrites.get(singleId);
  if (existing) return existing;
  const profileId = currentUser.id;
  const epoch = syncEpoch;
  const task = (async () => {
    // Одна запись на сингл одновременно: поздний ответ не перезапишет новый балл.
    while (epoch === syncEpoch && currentUser?.id === profileId) {
      const pending = pendingSingleRatings.get(singleId);
      if (!pending || pending.savedAfterRead !== undefined) return;
      pending.failed = false;
      setSingleSave('save');
      try {
        if (CLOUD) {
          const result = pending.value
            ? await getSB().from('single_ratings').upsert(
              { album_id: singleId, profile_id: profileId, ...pending.value },
              { onConflict: 'album_id,profile_id' },
            )
            : await getSB().from('single_ratings').delete().eq('album_id', singleId).eq('profile_id', profileId);
          if (result.error) throw result.error;
        } else saveLocalSingleRatings();
      } catch (err) {
        if (epoch !== syncEpoch) return;
        if (pendingSingleRatings.get(singleId) !== pending) continue;
        pending.failed = true;
        setSingleSave('err');
        throw err;
      }
      if (epoch !== syncEpoch) return;
      if (pendingSingleRatings.get(singleId) !== pending) continue;
      pending.savedAfterRead = dataReadRevision;
      setSingleSave('done');
      requestSync(0);
      return;
    }
  })().finally(() => {
    if (singleWrites.get(singleId) === task) singleWrites.delete(singleId);
  });
  singleWrites.set(singleId, task);
  return task;
}

/* Подтверждение идёт через ту же очередь записи, что и изменение балла. */
async function toggleSingleConfirm(): Promise<void> {
  const s = currentSingle();
  if (!s || !currentUser || !canEvaluate(s, currentUser.id)) return;
  const entry = singleRatings[s.id]?.[currentUser.id];
  if (!entry) return;
  const epoch = syncEpoch;
  const previous = entry.confirmed;
  const next = !previous;
  entry.confirmed = next;
  const pending = stageSingleSave(s.id);
  mirrorSingleToTracks(s.id, true);
  if (!CLOUD) saveLocalSingleRatings();
  updateSingleDisplays();
  // Как и у трека: кнопка сразу показывает новое состояние и не блокируется на время
  // записи, иначе клик по ✓ после правки балла терялся бы.
  if (epoch === syncEpoch) {
    if (!next) toast('Оценку можно менять — сингл пока не в рейтинге');
    else if (singleAllConfirmed(s.id)) toast('Оценка подтверждена — сингл в рейтинге');
    else {
      // Второй участник ещё не оценил (или не подтвердил) — релиз пока вне рейтинга.
      const myId = currentUser.id;
      const peers = Object.keys(singleRatings[s.id] ?? {}).filter((pid) => pid !== myId);
      toast(peers.length === 0
        ? 'Оценка подтверждена — ждём оценку второго участника'
        : 'Оценка подтверждена — ждём подтверждения второго участника');
    }
  }
  try {
    await persistSingleRating(s.id);
  } catch (err) {
    if (epoch !== syncEpoch) return;
    if (pendingSingleRatings.get(s.id) === pending) {
      const mine = singleRatings[s.id]?.[currentUser.id];
      if (mine) {
        mine.confirmed = previous;
        pending.value = { ...mine };
      }
      if (!CLOUD) saveLocalSingleRatings();
    }
    mirrorSingleToTracks(s.id, true); // откат тоже должен уехать в трек
    updateSingleDisplays();
    toast(messageOf(err));
  }
}

svSlider.addEventListener('input', () => {
  const v = round2(parseFloat(svSlider.value));
  svNum.value = fmt(v);
  setSingleRating(v);
});
svSlider.addEventListener('pointerdown', () => { singlePointerActive = true; });
window.addEventListener('pointerup', () => { singlePointerActive = false; });
svNum.addEventListener('input', () => {
  const raw = svNum.value.trim();
  if (raw === '') {
    svSlider.value = '5';
    clearSingleRating();
    svConfirmBtn.disabled = true;
    return;
  }
  const parsed = parseFloat(raw.replace(',', '.'));
  if (isNaN(parsed)) return;
  const v = round2(Math.min(10, Math.max(0, parsed)));
  svSlider.value = String(v);
  setSingleRating(v);
});
svSlider.addEventListener('change', () => {
  singlePointerActive = false;
  syncSingleControls();
});
svNum.addEventListener('blur', () => {
  const raw = svNum.value.trim();
  if (raw !== '') {
    const parsed = parseFloat(raw.replace(',', '.'));
    if (!isNaN(parsed)) svNum.value = fmt(round2(Math.min(10, Math.max(0, parsed))));
  }
  syncSingleControls();
});
svConfirmBtn.addEventListener('click', () => void toggleSingleConfirm());

/* --- открытие и удаление сингла --- */
async function openSingle(id: string): Promise<void> {
  const s = singleById(id);
  if (!s) return;
  if (currentSingleId !== id) delete svParentLabel.dataset.content;
  currentSingleId = id;
  currentAlbumId = null;
  renderSinglePage(s);
  await navigateTo(viewSingle, { view: 'single', singleId: id });
  startVinylLyrics(s); // пластинка: поиск текста запускается сразу при входе
}

singleBack.addEventListener('click', () => void goBack());

async function handleDeleteSingle(): Promise<void> {
  const s = currentSingle();
  if (!s) return;
  const ok = await openConfirm(
    'Удалить сингл?',
    `Сингл <b>«${esc(singleDisplayTitle(s))}»</b> — ${esc(singleArtistText(s))} будет удалён <b>навсегда</b> вместе с оценками. Метка «сингл» с трека снимется. Это действие нельзя отменить.`,
    true,
  );
  if (!ok) return;
  try {
    if (CLOUD) {
      const { error } = await getSB().from('albums').delete().eq('id', s.id);
      if (error) throw error;
      await refreshData();
    } else {
      albums = albums.filter((a) => a.id !== s.id);
      delete singleRatings[s.id];
      pendingSingleRatings.delete(s.id);
      tracks = tracks.map((t) => (t.singleId === s.id ? { ...t, singleId: null } : t));
      saveLocalAlbums();
      saveLocalTracks();
      saveLocalSingleRatings();
    }
    currentSingleId = null;
    viewStack.length = 0;
    viewStack.push({ view: 'home' });
    await crumbleCover('.sv__cover');
    setHomeMode('single', false);
    renderAlbums();
    await swapTo(viewSingle, viewHome, () => { viewHome.scrollTop = 0; });
    toast('Сингл удалён');
  } catch (err) {
    toast(messageOf(err));
  }
}

singleDeleteBtn.addEventListener('click', () => void handleDeleteSingle());

/* --- привязка сингла к альбому --- */
let singleLinkEditingId: string | null = null;
/** CSV: кавычки позволяют выбрать альбом, в названии которого есть запятая. */
function albumTokens(value: string): string[] {
  const tokens: string[] = [];
  let token = '', quoted = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (c === '"') {
      if (quoted && value[i + 1] === '"') { token += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ',' && !quoted) { tokens.push(token.trim()); token = ''; }
    else token += c;
  }
  tokens.push(token.trim());
  return tokens;
}

function albumInputLabel(a: UiAlbum): string {
  return albumsOnly().filter((x) => x.title.toLowerCase() === a.title.toLowerCase()).length > 1
    ? `${a.title} — ${a.artist} (${a.year}) [${a.id}]` : a.title;
}
function quoteAlbumToken(token: string): string {
  return /[,"\n]/.test(token) ? `"${token.replace(/"/g, '""')}"` : token;
}
function singleLinkErrorMessage(err: unknown): string {
  const message = messageOf(err);
  return /parent_album_ids/.test(message)
    ? 'Для нескольких альбомов нужна миграция базы: выполните migrate.sql в Supabase' : message;
}
function resolveAlbumTokens(value: string): string[] {
  const ids: string[] = [];
  for (const token of albumTokens(value).filter(Boolean)) {
    const matches = albumsOnly().filter((a) => albumInputLabel(a).toLowerCase() === token.toLowerCase()
      || a.title.toLowerCase() === token.toLowerCase());
    if (matches.length !== 1) throw new Error(matches.length
      ? `Название «${token}» неоднозначно — выберите альбом из подсказок`
      : `Альбом «${token}» не найден — выберите из подсказок или очистите поле`);
    if (!ids.includes(matches[0].id)) ids.push(matches[0].id);
  }
  return ids;
}
function updateAlbumSuggestions(input: HTMLInputElement, list: HTMLUListElement, picked?: (a: UiAlbum) => void): void {
  const tokens = albumTokens(input.value);
  const query = tokens.pop()!.toLowerCase();
  const selected = tokens.map((t) => t.toLowerCase());
  const matches = albumsOnly().filter((a) => !selected.includes(albumInputLabel(a).toLowerCase())
    && (!query || a.title.toLowerCase().includes(query) || a.artist.toLowerCase().includes(query))).slice(0, 8);
  list.innerHTML = '';
  for (const a of matches) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'combo__item';
    btn.innerHTML = `<span class="combo__name">${esc(a.title)}</span><span class="combo__tag">${esc(a.artist)} · ${a.year}</span>`;
    btn.addEventListener('pointerdown', (e) => e.preventDefault());
    btn.addEventListener('click', () => {
      input.value = [...tokens.filter(Boolean), albumInputLabel(a)].map(quoteAlbumToken).join(', ');
      list.hidden = true;
      input.focus();
      list.hidden = true;
      picked?.(a);
    });
    li.appendChild(btn);
    list.appendChild(li);
  }
  list.hidden = !matches.length;
}
function updateSingleLinkList(): void {
  updateAlbumSuggestions(singleLinkInput, singleLinkList);
}

function openSingleLinkEditor(): void {
  const s = currentSingle();
  if (!s || singleLinkDialog.open) return;
  singleLinkEditingId = s.id;
  singleLinkInput.value = parentsOf(s).map((a) => quoteAlbumToken(albumInputLabel(a))).join(', ');
  singleLinkName.textContent = releaseFullName(s);
  singleLinkError.textContent = '';
  singleLinkError.classList.remove('is-visible');
  singleLinkSave.classList.remove('is-loading');
  singleLinkDialog.showModal();
  void singleLinkDialog.offsetWidth;
  singleLinkDialog.classList.add('is-open');
  updateSingleLinkList();
}

function closeSingleLinkEditor(): void {
  if (!singleLinkDialog.open) return;
  singleLinkDialog.classList.remove('is-open');
  singleLinkList.hidden = true;
  window.setTimeout(() => {
    if (!singleLinkDialog.classList.contains('is-open')) singleLinkDialog.close();
  }, 240);
}

async function saveSingleLink(parentIds: string[]): Promise<void> {
  const id = singleLinkEditingId;
  if (!id || singleLinkSave.classList.contains('is-loading')) return;
  const single = singleById(id);
  if (!single) { closeSingleLinkEditor(); return; }
  if (JSON.stringify(parentIdsOf(single)) === JSON.stringify(parentIds)) { closeSingleLinkEditor(); return; }
  singleLinkSave.classList.add('is-loading');
  try {
    assertCompatibleParents(single, parentIds);
    if (CLOUD) {
      const { error } = await getSB().from('albums').update({ parent_album_id: parentIds[0] ?? null, parent_album_ids: parentIds }).eq('id', id);
      if (error) throw error;
    }
    albums = albums.map((a) => (a.id === id ? { ...a, parentId: parentIds[0] ?? null, parentIds } : a));
    if (!CLOUD) saveLocalAlbums();
    closeSingleLinkEditor();
    // Сингл — это тоже трек: при привязке он появляется в списке треков альбома.
    const warn = await attachSingleTracks(id, parentIds);
    const updated = singleById(id);
    if (currentSingle()?.id === id && updated) renderSinglePage(updated);
    if (currentAlbumId) { renderTracks(); renderAlbumSingles(); }
    toast(warn ?? (parentIds.length ? 'Привязки сингла сохранены' : 'Сингл больше не привязан к альбомам'));
    requestSync(0);
  } catch (err) {
    singleLinkError.textContent = singleLinkErrorMessage(err);
    singleLinkError.classList.add('is-visible');
  } finally {
    singleLinkSave.classList.remove('is-loading');
  }
}

svParentEdit.addEventListener('click', openSingleLinkEditor);
svParentLabel.addEventListener('click', handleParentClick);

/* --- глаз у привязки: пока зажат — рядом видна миниатюра обложки альбома --- */
function showParentPeek(): void {
  if (svPeekBtn.hidden) return;
  // у правого края экрана карточка разворачивается влево, чтобы не уезжать за край
  const box = svPeekBtn.getBoundingClientRect();
  svPeekCard.classList.toggle('is-flip', box.right + 200 > window.innerWidth);
  svPeekCard.hidden = false;
}
function hideParentPeek(): void {
  svPeekCard.hidden = true;
}
svPeekBtn.addEventListener('pointerdown', (e) => {
  e.preventDefault(); // без перетаскивания текста и фокуса — чистое «зажатие»
  showParentPeek();
});
for (const type of ['pointerup', 'pointercancel'] as const) {
  window.addEventListener(type, hideParentPeek);
}
svPeekBtn.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  e.preventDefault();
  showParentPeek();
});
svPeekBtn.addEventListener('keyup', (e) => {
  if (e.key === 'Enter' || e.key === ' ') hideParentPeek();
});
svPeekBtn.addEventListener('blur', hideParentPeek);
svPeekBtn.addEventListener('contextmenu', (e) => e.preventDefault()); // долгий тап на телефоне
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') hideParentPeek();
});
svArtist.addEventListener('click', (e) => {
  const a = (e.target as HTMLElement).closest<HTMLAnchorElement>('.sv__artist-link');
  if (!a) return;
  e.preventDefault();
  const name = a.dataset.artist;
  if (name) void openArtist(name);
});
singleLinkInput.addEventListener('input', () => {
  updateSingleLinkList();
});
singleLinkInput.addEventListener('focus', updateSingleLinkList);
singleLinkInput.addEventListener('blur', () => {
  window.setTimeout(() => {
    if (!singleLinkBox.contains(document.activeElement)) singleLinkList.hidden = true;
  }, 120);
});
document.addEventListener('click', (e) => {
  if (!singleLinkBox.contains(e.target as Node)) singleLinkList.hidden = true;
});
singleLinkCancel.addEventListener('click', closeSingleLinkEditor);
singleLinkDialog.addEventListener('cancel', (e) => {
  e.preventDefault();
  closeSingleLinkEditor();
});
singleLinkUnlink.addEventListener('click', () => void saveSingleLink([]));
singleLinkForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (singleLinkSave.classList.contains('is-loading')) return;
  try {
    void saveSingleLink(resolveAlbumTokens(singleLinkInput.value));
  } catch (err) {
    singleLinkError.textContent = singleLinkErrorMessage(err);
    singleLinkError.classList.add('is-visible');
  }
});

/* --- сингл как трек альбома --- */

/** «Not Like Us & Kendrick Lamar» → «Not Like Us» (сравнение названий треков). */
function stripFeat(title: string): string {
  const m = FEAT_RE.exec(title);
  return (m ? title.slice(0, m.index) : title).trim();
}

/**
 * Сингл — это тоже трек: при привязке к альбому он попадает в конец списка треков.
 * Если трек с таким названием уже есть, он просто помечается синглом (без дубля).
 * Коллаборация: артист сингла отличается от артиста альбома → «Название & Артист»
 * со ссылкой на профиль (та же механика фитов, что и у обычных треков).
 * Возвращает текст предупреждения, если трек добавить не удалось.
 */
async function attachSingleTracks(singleId: string, parentIds: string[]): Promise<string | null> {
  const warnings: string[] = [];
  for (const id of parentIds) {
    const warning = await attachSingleTrack(singleId, id);
    if (warning) warnings.push(`${albums.find((a) => a.id === id)?.title}: ${warning}`);
  }
  shareRatingsWithSingles();
  return warnings.length ? warnings.join('; ') : null;
}

async function attachSingleTrack(singleId: string, parentId: string): Promise<string | null> {
  const single = singleById(singleId);
  const al = albums.find((a) => a.id === parentId && a.kind === 'album');
  if (!single || !al) return null;
  assertCompatibleParents(single, [parentId]);
  if (al.tracksLocked) {
    return 'Сингл привязан, но треки альбома зафиксированы — в списке треков он не появился';
  }
  // Название трека строим от чистого названия сингла: фит из названия сингла
  // живёт в блоке артиста сингла, а не в названии трека чужого альбома.
  const info = singleTitleInfo(single);
  const title = info.title;
  const sameArtist = al.artist.trim().toLowerCase() === single.artist.trim().toLowerCase();
  // Свой альбом: гость из названия остаётся фит-ссылкой на треке.
  // Чужой альбом: совместка «Название & Артист сингла».
  const feat = sameArtist
    ? (info.featArtist ? canonicalArtistName(info.featArtist) : null)
    : canonicalArtistName(single.artist);
  const fullTitle = feat && !sameArtist ? `${title} & ${feat}` : title;

  const existing = tracks.find(
    (t) => t.albumId === parentId && stripFeat(t.title).toLowerCase() === title.toLowerCase(),
  );
  try {
    if (existing) {
      if (existing.singleId) return null; // трек уже отмечен (этим же или другим синглом)
      if (CLOUD) {
        const { error } = await getSB().from('tracks').update({ single_id: singleId }).eq('id', existing.id);
        if (error) throw error;
        await refreshData();
      } else {
        tracks = tracks.map((t) => (t.id === existing.id ? { ...t, singleId } : t));
        saveLocalTracks();
      }
      return null;
    }

    const position = tracks.filter((t) => t.albumId === parentId).length;
    if (CLOUD) {
      const { error } = await getSB().from('tracks').insert({
        album_id: parentId, title: fullTitle, position, locked: false,
        feat_artist: feat, single_id: singleId,
      });
      if (error) throw error;
      await refreshData();
    } else {
      tracks.push({
        id: 't' + crypto.randomUUID(), albumId: parentId, title: fullTitle,
        position, locked: false, featArtist: feat, singleId, geniusId: null,
      });
      saveLocalTracks();
    }
    return null;
  } catch (err) {
    return 'Сингл привязан, но трек в альбоме создать не удалось: ' + messageOf(err);
  }
}

/* --- метка «трек — сингл» --- */
function singleOfTrack(t: UiTrack): UiAlbum | undefined {
  return t.singleId ? singleById(t.singleId) : undefined;
}

async function markTrackAsSingle(t: UiTrack): Promise<void> {
  const al = albums.find((a) => a.id === t.albumId);
  if (!al || !currentUser) return;
  if (!singleById(t.singleId ?? '')) {
    // Название трека должно быть чистым, а фит — в отдельном поле: выносим
    // гостя из названия (если он там) и приводим трек в порядок заранее.
    const guestFromTitle = featNameOf(t.title)?.replace(/[),.\s]+$/, '').trim() ?? '';
    const guest = (t.featArtist ?? '').trim() || guestFromTitle || '';
    const cleanTitle = stripFeat(t.title).trim() || t.title.trim();
    const singleTitle = guest ? `${cleanTitle} (feat. ${canonicalArtistName(guest)})` : cleanTitle;
    try {
      if (CLOUD) {
        const ins = await getSB().from('albums').insert({
          artist: al.artist,
          title: singleTitle,
          year: al.year,
          cover_url: null,
          tracks_locked: false,
          kind: 'single',
          parent_album_id: al.id,
          created_by: currentUser.id,
          ...(al.evaluatorId ? { evaluator_id: al.evaluatorId } : {}),
        }).select('id').single();
        if (ins.error) {
          if (ins.error.code === '23505') throw new Error('Такой сингл у этого артиста уже есть');
          throw ins.error;
        }
        const singleId = (ins.data as { id: string }).id;
        const upd = await getSB().from('tracks').update({
          single_id: singleId,
          ...(t.title !== cleanTitle || (t.featArtist ?? '') !== guest ? { title: cleanTitle, feat_artist: guest || null } : {}),
        }).eq('id', t.id);
        if (upd.error) throw upd.error;
        await refreshData();
      } else {
        const singleId = 's' + Date.now().toString(36);
        albums.push({
          id: singleId, artist: al.artist, title: singleTitle, year: al.year, cover: '',
          evaluatorId: al.evaluatorId ?? null,
          kind: 'single', parentId: al.id, tracksLocked: false, cohesion: null, albumType: null,
        });
        tracks = tracks.map((x) => (x.id === t.id ? { ...x, title: cleanTitle, featArtist: guest || null, singleId } : x));
        saveLocalAlbums();
        saveLocalTracks();
        shareRatingsWithSingles();
      }
      toast('Трек отмечен как сингл');
      renderTracks();
      renderAlbumSingles();
      requestSync(0);
    } catch (err) {
      const msg = messageOf(err);
      toast(/column|relation|schema|does not exist/i.test(msg)
        ? 'Нужна миграция базы: выполните migrate.sql в Supabase'
        : msg);
    }
  }
  const created = tracks.find((x) => x.id === t.id)?.singleId;
  if (created) void openSingle(created);
}

async function unmarkTrackAsSingle(t: UiTrack): Promise<void> {
  const single = singleOfTrack(t);
  const ok = await openConfirm(
    'Снять метку «сингл»?',
    single
      ? `Трек <b>«${esc(t.title)}»</b> перестанет быть синглом. Карточка сингла <b>«${esc(singleDisplayTitle(single))}»</b> и его оценки останутся — удалить его можно отдельно, на странице сингла.`
      : `Трек <b>«${esc(t.title)}»</b> перестанет быть синглом.`,
  );
  if (!ok) return;
  try {
    if (CLOUD) {
      const { error } = await getSB().from('tracks').update({ single_id: null }).eq('id', t.id);
      if (error) throw error;
      await refreshData();
    } else {
      tracks = tracks.map((x) => (x.id === t.id ? { ...x, singleId: null } : x));
      saveLocalTracks();
    }
    toast('Метка снята');
    renderTracks();
    renderAlbumSingles();
    requestSync(0);
  } catch (err) {
    toast(messageOf(err));
  }
}

/* клик по помеченному треку спрашивает, перейти ли на страницу сингла */
async function promptSingleFromTrack(t: UiTrack): Promise<void> {
  const single = singleOfTrack(t);
  if (!single) return;
  const ok = await openConfirm(
    'Перейти на страницу сингла?',
    `Трек <b>«${esc(t.title)}»</b> отмечен как сингл <b>«${esc(singleDisplayTitle(single))}»</b>. Открыть его страницу с оценками?`,
    false,
    { ok: 'да', cancel: 'назад' },
  );
  if (ok) void openSingle(single.id);
}

/* синглы, привязанные к этому альбому */
function renderAlbumSingles(): void {
  const al = currentAlbum();
  if (!al) { avSinglesSection.hidden = true; return; }
  const list = albums.filter((a) => a.kind === 'single' && parentIdsOf(a).includes(al.id));
  avSinglesSection.hidden = list.length === 0;
  avSinglesCount.textContent = `${list.length} ${singlesPlural(list.length)}`;
  avSingles.innerHTML = '';
  for (const s of list) avSingles.appendChild(makeSingleRow(s));
}

/* ==========================================================================
   ПОИСК ОБЛОЖЕК ОНЛАЙН — iTunes и Deezer
   Платформы-источники обложек для новых релизов и замены обложек.
   iTunes и Deezer подключены (бесплатные API без ключей); SoundCloud и
   Genius зарезервированы — включатся в реестре ниже, когда появятся ключи.

   Транспорт — JSONP: и iTunes (параметр callback), и Deezer
   (output=jsonp&callback) отдают данные скриптом, поэтому запросы работают
   прямо из браузера на любом домене (Cloudflare, localhost, превью) без
   серверного прокси — у Deezer нет CORS-заголовков, а JSONP их не требует.
   Каждая платформа ищет независимо: своя секция, свой статус и своя ошибка
   с раскрываемыми деталями и кнопкой «скопировать отчёт».
   ========================================================================== */

/** Сколько вариантов показывает каждая платформа. */
const COVER_SEARCH_LIMIT = 6;
/** Таймаут ожидания ответа платформы. */
const COVER_SEARCH_TIMEOUT = 10000;
/** Задержка авто-поиска после изменения артиста/названия или запроса. */
const COVER_SEARCH_DEBOUNCE = 700;

interface CoverHit {
  /** Ссылка на изображение в полном размере — она и сохраняется в обложку. */
  url: string;
  /** Уменьшенная копия для сетки результатов. */
  thumb: string;
  /** Подпись (название релиза, год). */
  caption: string;
}

type CoverSearchStage = 'network' | 'timeout' | 'parse';

/** Ошибка поиска с этапом, на котором она произошла, — попадает в отчёт. */
class CoverSearchError extends Error {
  constructor(readonly stage: CoverSearchStage, message: string) {
    super(message);
  }
}

/* ---------- JSONP: <script> с глобальным колбэком, таймаут и уборка ---------- */

/** Ручка отмены поиска: флаг + контроллер для отмены обычного fetch. */
interface CoverAbort {
  aborted: boolean;
  controller?: AbortController;
}

let coverJsonpSeq = 0;

function coverJsonp(url: string, abort: CoverAbort): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const callbackName = `__coverSearchCb${Date.now().toString(36)}_${++coverJsonpSeq}`;
    const scope = window as unknown as Record<string, unknown>;
    const script = document.createElement('script');
    let settled = false;
    const timer = window.setTimeout(() => {
      settle(() => reject(new CoverSearchError('timeout', `ответ не пришёл за ${Math.round(COVER_SEARCH_TIMEOUT / 1000)} с`)));
    }, COVER_SEARCH_TIMEOUT);
    const cleanup = (): void => {
      window.clearTimeout(timer);
      delete scope[callbackName];
      script.remove();
    };
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!abort.aborted) fn(); // отменённый запрос просто замолкает
    };
    scope[callbackName] = (data: unknown) => settle(() => resolve(data));
    script.addEventListener('error', () => {
      settle(() => reject(new CoverSearchError('network', 'запрос не выполнен — нет сети, мешает блокировщик/расширение или API недоступен')));
    });
    script.src = `${url}${url.includes('?') ? '&' : '?'}callback=${encodeURIComponent(callbackName)}`;
    document.head.appendChild(script);
  });
}

/** Обычный fetch JSON (для API с CORS, но без JSONP — как Genius).
    Обычный GET: у Deezer/iTunes используется JSONP (ниже), а Genius ходит
    через наш прокси /api/genius/* — токен остаётся на сервере. */
async function coverFetchJson(url: string, abort: CoverAbort): Promise<unknown> {
  const controller = new AbortController();
  abort.controller = controller;
  const timer = window.setTimeout(() => controller.abort(), COVER_SEARCH_TIMEOUT);
  try {
    const response = await fetch(url, { signal: controller.signal, mode: 'cors', credentials: 'omit' });
    if (!response.ok) {
      throw new CoverSearchError('network', `API вернул HTTP-статус ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    if (err instanceof CoverSearchError) throw err;
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      throw new CoverSearchError('timeout', `ответ не пришёл за ${Math.round(COVER_SEARCH_TIMEOUT / 1000)} с`);
    }
    if (err instanceof TypeError) {
      throw new CoverSearchError('network', 'запрос не выполнен — нет сети или API не разрешает запросы из браузера (CORS)');
    }
    throw new CoverSearchError('parse', `не удалось разобрать ответ: ${messageOf(err)}`);
  } finally {
    window.clearTimeout(timer);
  }
}

/* ---------- Разбор ответов платформ ---------- */

function coverArtUpscale(url: string, size: number): string {
  return url.replace(/\/\d+x\d+bb\.([a-z]+)(\?.*)?$/i, `/${size}x${size}bb.$1`);
}

function parseItunes(data: unknown): CoverHit[] {
  if (!data || typeof data !== 'object') throw new CoverSearchError('parse', 'пустой или некорректный ответ');
  const results = (data as { results?: unknown }).results;
  if (!Array.isArray(results)) throw new CoverSearchError('parse', 'в ответе нет массива results');
  const hits: CoverHit[] = [];
  const seen = new Set<string>();
  for (const item of results) {
    const art = (item as { artworkUrl100?: unknown } | null)?.artworkUrl100;
    if (typeof art !== 'string' || !art.startsWith('http')) continue;
    const big = coverArtUpscale(art, 600);
    if (seen.has(big)) continue;
    seen.add(big);
    const name = (item as { collectionName?: unknown }).collectionName;
    const released = (item as { releaseDate?: unknown }).releaseDate;
    const year = typeof released === 'string' && /^\d{4}/.test(released) ? ` · ${released.slice(0, 4)}` : '';
    hits.push({
      url: big,
      thumb: coverArtUpscale(art, 300),
      caption: typeof name === 'string' ? `${name}${year}` : '',
    });
    if (hits.length >= COVER_SEARCH_LIMIT) break;
  }
  return hits;
}

function parseDeezer(data: unknown): CoverHit[] {
  if (!data || typeof data !== 'object') throw new CoverSearchError('parse', 'пустой или некорректный ответ');
  const results = (data as { data?: unknown }).data;
  if (!Array.isArray(results)) {
    const apiError = (data as { error?: { message?: unknown } }).error;
    if (apiError && typeof apiError === 'object') {
      throw new CoverSearchError('parse', `API вернул ошибку: ${typeof apiError.message === 'string' ? apiError.message : 'неизвестную'}`);
    }
    throw new CoverSearchError('parse', 'в ответе нет массива data');
  }
  const hits: CoverHit[] = [];
  const seen = new Set<string>();
  for (const item of results) {
    const rec = item as { cover_xl?: unknown; cover_big?: unknown; cover_medium?: unknown; cover?: unknown; title?: unknown; artist?: { name?: unknown } };
    const big = [rec.cover_xl, rec.cover_big, rec.cover].find((u): u is string => typeof u === 'string' && u.startsWith('http'));
    const mid = [rec.cover_medium, rec.cover_big, rec.cover].find((u): u is string => typeof u === 'string' && u.startsWith('http'));
    if (!big || !mid || seen.has(big)) continue;
    seen.add(big);
    const title = typeof rec.title === 'string' ? rec.title : '';
    const artistName = typeof rec.artist?.name === 'string' ? rec.artist.name : '';
    hits.push({
      url: big,
      thumb: mid,
      caption: artistName ? `${artistName} — ${title}` : title,
    });
    if (hits.length >= COVER_SEARCH_LIMIT) break;
  }
  return hits;
}

/* ---------- Реестр платформ: новая платформа = один объект здесь ---------- */

/** У Genius размер картинки зашит в путь: …/hash.300x300x1.jpg → подставим больший. */
function geniusArtUpscale(url: string): string {
  return url.replace(/\.(\d+)x(\d+)x1\.jpg$/i, '.1000x1000x1.jpg');
}

function parseGenius(data: unknown): CoverHit[] {
  if (!data || typeof data !== 'object') throw new CoverSearchError('parse', 'пустой или некорректный ответ');
  const response = (data as { response?: unknown }).response;
  const hits = (response as { hits?: unknown } | null)?.hits;
  if (!Array.isArray(hits)) {
    const meta = (data as { meta?: { status?: unknown; message?: unknown } }).meta;
    if (meta && meta.status !== undefined && meta.status !== 200) {
      throw new CoverSearchError('parse', `API вернул статус ${String(meta.status)}${typeof meta.message === 'string' ? `: ${meta.message}` : ''}`);
    }
    throw new CoverSearchError('parse', 'в ответе нет массива hits');
  }
  const hitsList: CoverHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    if ((hit as { type?: unknown }).type !== 'song') continue; // берём только треки (арты песен)
    const result = (hit as { result?: Record<string, unknown> | null }).result;
    if (!result) continue;
    const thumb = [result.song_art_image_thumbnail_url, result.song_art_image_url]
      .find((u): u is string => typeof u === 'string' && u.startsWith('http'));
    const big = [result.song_art_image_url, result.song_art_image_thumbnail_url]
      .find((u): u is string => typeof u === 'string' && u.startsWith('http'));
    if (!thumb || !big || seen.has(big)) continue;
    seen.add(big);
    const title = typeof result.title === 'string' ? result.title : '';
    const artistName = (result.primary_artist as { name?: unknown } | null | undefined)?.name;
    hitsList.push({
      url: geniusArtUpscale(big),
      thumb,
      caption: typeof artistName === 'string' ? `${artistName} — ${title}` : title,
    });
    if (hitsList.length >= COVER_SEARCH_LIMIT) break;
  }
  return hitsList;
}

interface CoverProvider {
  id: string;
  name: string;
  enabled: boolean;
  /** jsonp — скриптовый JSONP; fetch — обычный GET+JSON (нужен CORS у API). */
  transport: 'jsonp' | 'fetch';
  /** Знак платформы: внутренняя разметка SVG 24×24 в currentColor. */
  logo: string;
  /** Почему платформа пока не подключена (для примечания под результатами). */
  hint?: string;
  /** Собрать URL запроса; JSONP добавит callback, fetch идёт по этому адресу. */
  buildUrl(query: string): string;
  /** Разобрать ответ в варианты (бросает CoverSearchError('parse')). */
  parse(data: unknown): CoverHit[];
}

const COVER_PROVIDERS: CoverProvider[] = [
  {
    id: 'deezer',
    name: 'Deezer',
    enabled: true,
    transport: 'jsonp',
    // фирменный эквалайзер Deezer: четыре колонки ступенчатых полос
    logo: '<path d="M18.81 4.16v3.03H24V4.16h-5.19zM6.27 8.38v3.027h5.189V8.38h-5.19zm12.54 0v3.027H24V8.38h-5.19zM0 12.595v3.027h5.19v-3.027H0zm6.27 0v3.027h5.189v-3.027h-5.19zm12.54 0v3.027H24v-3.027h-5.19zM0 16.81v3.029h5.19v-3.03H0zm6.27 0v3.029h5.189v-3.03h-5.19zm6.27 0v3.029h5.19v-3.03h-5.19zm6.27 0v3.029H24v-3.03h-5.19z"/>',
    buildUrl: (q0) => `https://api.deezer.com/search/album?q=${encodeURIComponent(q0)}&limit=${COVER_SEARCH_LIMIT}&output=jsonp`,
    parse: parseDeezer,
  },
  {
    id: 'genius',
    name: 'Genius',
    enabled: true,
    transport: 'fetch',
    // знак Genius — жёлтый улыбающийся кругляшек (в тон заглушке-обложке сайта)
    // фирменный знак Genius («G в Genius», официально public domain:
    // Wikimedia Commons, File:G in Genius.svg) — трассировка оригинала 1:1
    logo: '<path d="M17.58 19.48 16.0 20.4 14.46 20.96 13.28 21.22 11.13 21.42 9.29 21.17 7.34 20.6 5.7 19.79 3.8 18.3 3.8 18.04 4.11 17.94 4.93 18.3 6.93 18.71 8.98 18.76 10.82 18.5 12.61 17.94 14.0 17.28 16.0 15.84 16.97 14.87 18.15 13.28 18.97 11.69 19.43 10.36 19.79 8.57 19.84 6.52 19.58 4.68 19.02 3.04 19.12 2.78 19.38 2.78 20.66 4.32 21.68 6.26 22.24 8.21 22.5 9.8 22.5 10.98 22.09 13.23 21.68 14.46 21.01 15.84 19.63 17.74 18.4 18.91ZM4.42 10.98 4.52 11.95 4.83 12.77 4.73 13.08 4.37 13.02 3.24 12.05 2.63 11.28 2.01 10.16 1.65 9.08 1.5 7.95 1.6 6.21 1.81 5.39 2.47 4.01 3.24 2.99 3.65 2.58 6.37 2.58 6.47 2.78 6.47 5.39 5.5 6.52 4.73 8.11 4.42 9.49ZM9.7 7.75 10.67 7.29 11.39 6.26 11.49 5.8 11.49 2.83 11.64 2.58 13.69 2.58 14.51 3.75 15.12 5.34 15.02 5.85 14.1 5.9 13.95 8.72 13.49 9.54 12.72 10.16 11.9 10.41 11.13 10.41 10.0 9.95 9.23 9.08 8.98 8.31 9.08 7.9Z"/>',
    // Поиск через серверный прокси /api/genius/search (в проде — worker.js,
    // в превью — server.py): токен Genius хранится на сервере, не в браузере.
    buildUrl: (q0) => `/api/genius/search?q=${encodeURIComponent(q0)}&per_page=${COVER_SEARCH_LIMIT}`,
    parse: parseGenius,
  },
  {
    id: 'itunes',
    name: 'iTunes',
    enabled: true,
    transport: 'jsonp',
    // яблоко — знак iTunes Store / Apple Music
    logo: '<path d="M12.152 6.896c-.948 0-2.415-1.078-3.96-1.04-2.04.027-3.91 1.183-4.961 3.014-2.117 3.675-.546 9.103 1.519 12.09 1.013 1.454 2.208 3.09 3.792 3.039 1.52-.065 2.09-.987 3.935-.987 1.831 0 2.35.987 3.96.948 1.637-.026 2.676-1.48 3.676-2.948 1.156-1.688 1.636-3.325 1.662-3.415-.039-.013-3.182-1.221-3.22-4.857-.026-3.04 2.48-4.494 2.597-4.559-1.429-2.09-3.623-2.324-4.39-2.376-2-.156-3.675 1.09-4.61 1.09zM15.53 3.83c.843-1.012 1.4-2.427 1.245-3.83-1.207.052-2.662.805-3.532 1.818-.78.896-1.454 2.338-1.273 3.714 1.338.104 2.715-.688 3.559-1.701"/>',
    // country=US: самый полный каталог iTunes Store (RU-магазин с 2022 года закрыт).
    buildUrl: (q0) => `https://itunes.apple.com/search?media=music&entity=album&limit=${COVER_SEARCH_LIMIT}&country=US&term=${encodeURIComponent(q0)}`,
    parse: parseItunes,
  },
  /* --- зарезервировано: новая платформа = один объект здесь (enabled: false
         с подсказкой hint, пока нет ключей) --- */
];

function coverSearchNoteText(): string {
  const off = COVER_PROVIDERS.filter((p) => !p.enabled);
  return off.length ? `потом подключим: ${off.map((p) => `${p.name} — ${p.hint}`).join('; ')}` : '';
}

/* ---------- Отчёт об ошибке для доработки ---------- */

const COVER_STAGE_TEXT: Record<CoverSearchStage, string> = {
  network: 'network — запрос не выполнен (нет сети, мешает блокировщик/расширение или API недоступен)',
  timeout: `timeout — ответ не пришёл за ${Math.round(COVER_SEARCH_TIMEOUT / 1000)} с`,
  parse: 'parse — ответ получен, но не удалось разобрать',
};

function coverSearchReport(providerName: string, query: string, url: string, err: CoverSearchError): string {
  const build = document.querySelector<HTMLScriptElement>('script[src*="app.js"]')?.getAttribute('src') ?? 'app.js';
  return [
    'Поиск обложки — отчёт об ошибке',
    `платформа: ${providerName}`,
    `запрос: «${query}»`,
    `url запроса: ${url}`,
    `этап: ${COVER_STAGE_TEXT[err.stage]}`,
    `сообщение: ${err.message}`,
    `время: ${new Date().toISOString()}`,
    `страница: ${location.href}`,
    `сборка: ${build}`,
  ].join('\n');
}

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* переходим к резервному способу */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    ta.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function variantsPlural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'вариант';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'варианта';
  return 'вариантов';
}

/* ---------- Секция поиска: одна на форме добавления, другая в окне обложки ---------- */

interface CoverSearchRefs {
  root: HTMLElement;
  toggle: HTMLButtonElement;
  clip: HTMLElement;
  body: HTMLElement;
  query: HTMLInputElement;
  run: HTMLButtonElement;
  sections: HTMLElement;
  note: HTMLElement;
  /** Авто-запрос из контекста: артист + название (форма) или релиз (окно). */
  getContextQuery(): string | null;
  /** Выбор варианта: подставить обложку в форму или окно (штатное сохранение). */
  applyPick(hit: CoverHit): void;
  /** Сохранение/закрытие окна — на это время поиск блокируется. */
  isBlocked(): boolean;
}

interface CoverSectionRefs {
  section: HTMLElement;
  head: HTMLElement;
  state: HTMLElement;
  grid: HTMLElement;
  fail: HTMLElement;
  failToggle: HTMLButtonElement;
  report: HTMLElement;
  copy: HTMLButtonElement;
}

class CoverSearchBox {
  private manualEdit = false;      // запрос редактировали руками — авто-подстановка выключена
  private userToggled = false;     // пользователь сам открывал/закрывал секцию
  private seq = 0;                 // номер поиска: поздние ответы не применяются
  private timer: number | undefined;
  private aborts: CoverAbort[] = [];
  private selectedUrl: string | null = null;

  constructor(private readonly d: CoverSearchRefs) {
    d.note.textContent = coverSearchNoteText();
    d.note.hidden = !d.note.textContent;
    d.toggle.addEventListener('click', () => {
      if (d.isBlocked()) return;
      this.userToggled = true;
      if (this.isOpen) this.close();
      else this.open();
    });
    d.run.addEventListener('click', () => {
      if (d.isBlocked()) return;
      this.launch(d.query.value);
    });
    d.query.addEventListener('input', () => {
      window.clearTimeout(this.timer);
      if (d.query.value.trim() !== '') {
        this.manualEdit = true; // правим свой запрос — авто-подстановка подождёт
        const q0 = d.query.value;
        this.timer = window.setTimeout(() => this.launch(q0), COVER_SEARCH_DEBOUNCE);
      } else {
        // поле очистили: мгновенно ничего не подставляем — можно спокойно
        // вписать другой запрос; на форме добавления следующее изменение
        // артиста/названия снова подставит авто-запрос
        this.manualEdit = false;
      }
    });
    d.query.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault(); // поле внутри форм: Enter не должен отправлять форму
      if (!d.isBlocked()) this.launch(d.query.value);
    });
  }

  get isOpen(): boolean {
    return this.d.root.classList.contains('is-open');
  }

  /** Синхронизировать запрос с контекстом (артист+название / релиз) и, если он изменился, запустить поиск. */
  syncContext(delay = COVER_SEARCH_DEBOUNCE): void {
    if (this.manualEdit) return;
    const q0 = this.d.getContextQuery();
    window.clearTimeout(this.timer);
    if (!q0) return;
    if (this.d.query.value.trim() === q0 && this.d.sections.childElementCount > 0) return; // уже ищем/нашлось
    this.d.query.value = q0;
    this.timer = window.setTimeout(() => this.launch(q0), delay);
  }

  open(): void {
    this.d.root.classList.add('is-open');
    this.d.toggle.setAttribute('aria-expanded', 'true');
  }

  close(): void {
    this.d.root.classList.remove('is-open');
    this.d.toggle.setAttribute('aria-expanded', 'false');
  }

  /** Сброс: очистить результаты, выбор и флаги (при открытии/закрытии форм). */
  reset(): void {
    this.seq += 1;
    for (const a of this.aborts) { a.aborted = true; a.controller?.abort(); }
    this.aborts = [];
    window.clearTimeout(this.timer);
    this.manualEdit = false;
    this.userToggled = false;
    this.selectedUrl = null;
    this.d.query.value = '';
    this.d.sections.innerHTML = '';
    this.close();
  }

  /** Снять подсветку выбранного варианта (выбрали файл/ссылку вручную). */
  clearSelection(): void {
    this.selectedUrl = null;
    this.d.sections.querySelectorAll('.cover-search__card.is-selected')
      .forEach((c) => c.classList.remove('is-selected'));
  }

  /** Заблокировать/разблокировать управление (пока идёт сохранение обложки). */
  setBlocked(blocked: boolean): void {
    this.d.toggle.disabled = blocked;
    this.d.query.disabled = blocked;
    this.d.run.disabled = blocked;
  }

  private launch(qraw: string): void {
    window.clearTimeout(this.timer);
    const q0 = qraw.trim().replace(/\s+/g, ' ');
    this.seq += 1;
    const seq = this.seq;
    for (const a of this.aborts) { a.aborted = true; a.controller?.abort(); }
    this.aborts = [];
    this.selectedUrl = null;
    this.d.sections.innerHTML = '';
    if (!q0) return;
    const enabled = COVER_PROVIDERS.filter((p) => p.enabled);
    let pending = enabled.length;
    let anyHits = false;
    for (const provider of enabled) {
      const abort: CoverAbort = { aborted: false };
      this.aborts.push(abort);
      const url = provider.buildUrl(q0);
      const refs = this.buildSection(provider);
      this.d.sections.appendChild(refs.section);
      (provider.transport === 'fetch' ? coverFetchJson(url, abort) : coverJsonp(url, abort))
        .then((data) => {
          if (abort.aborted || seq !== this.seq) return;
          const hits = provider.parse(data); // может бросить CoverSearchError('parse')
          if (seq !== this.seq) return;
          refs.state.classList.remove('is-searching');
          if (!hits.length) {
            refs.state.textContent = 'ничего не найдено';
            return;
          }
          anyHits = true;
          refs.state.textContent = `${hits.length} ${variantsPlural(hits.length)}`;
          refs.grid.hidden = false;
          for (const hit of hits) refs.grid.appendChild(this.buildCard(provider, hit));
        })
        .catch((err) => {
          if (abort.aborted || seq !== this.seq) return;
          const searchErr = err instanceof CoverSearchError ? err : new CoverSearchError('network', messageOf(err));
          refs.state.classList.remove('is-searching');
          refs.state.classList.add('is-error');
          refs.state.textContent = `ошибка · ${searchErr.stage}`;
          refs.fail.hidden = false;
          refs.report.textContent = coverSearchReport(provider.name, q0, url, searchErr);
        })
        .finally(() => {
          pending -= 1;
          if (pending === 0 && seq === this.seq && !this.d.isBlocked() && anyHits && !this.userToggled && !this.isOpen) {
            this.open(); // результаты пришли — раскрываем секцию (если пользователь не распорядился сам)
          }
        });
    }
  }

  private buildSection(provider: CoverProvider): CoverSectionRefs {
    const section = document.createElement('section');
    section.className = 'cover-search__section';
    section.dataset.provider = provider.id;
    const head = document.createElement('header');
    head.className = 'cover-search__head';
    const name = document.createElement('span');
    name.className = 'cover-search__name';
    name.innerHTML = `${esc(provider.name)}<svg class="cover-search__logo" viewBox="0 0 24 24" aria-hidden="true">${provider.logo}</svg>`;
    const state = document.createElement('span');
    state.className = 'cover-search__state is-searching';
    state.textContent = 'ищем…';
    state.setAttribute('role', 'status');
    state.setAttribute('aria-live', 'polite');
    head.append(name, state);
    const grid = document.createElement('div');
    grid.className = 'cover-search__grid';
    grid.hidden = true;
    const fail = document.createElement('div');
    fail.className = 'cover-search__fail';
    fail.hidden = true;
    const failToggle = document.createElement('button');
    failToggle.type = 'button';
    failToggle.className = 'cover-search__fail-toggle';
    failToggle.textContent = 'показать детали';
    const report = document.createElement('pre');
    report.className = 'cover-search__report';
    report.hidden = true;
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.className = 'btn btn--ghost btn--sm cover-search__copy';
    copy.textContent = 'скопировать отчёт';
    copy.hidden = true;
    failToggle.addEventListener('click', () => {
      const willShow = report.hidden;
      report.hidden = !willShow;
      copy.hidden = !willShow;
      failToggle.textContent = willShow ? 'скрыть детали' : 'показать детали';
    });
    copy.addEventListener('click', () => {
      const ok = copyTextToClipboard(report.textContent ?? '');
      void Promise.resolve(ok).then((copied) => toast(copied ? 'Отчёт скопирован — вставьте его в сообщение разработчику' : 'Не удалось скопировать: выделите текст деталей и скопируйте вручную (Ctrl+C)'));
    });
    fail.append(failToggle, report, copy);
    section.append(head, grid, fail);
    return { section, head, state, grid, fail, failToggle, report, copy };
  }

  private buildCard(provider: CoverProvider, hit: CoverHit): HTMLButtonElement {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'cover-search__card';
    card.dataset.provider = provider.id;
    if (hit.caption) {
      card.title = hit.caption;
      card.setAttribute('aria-label', `Обложка: ${hit.caption}`);
    }
    const img = document.createElement('img');
    img.src = hit.thumb;
    img.alt = '';
    img.loading = 'lazy';
    card.appendChild(img);
    card.addEventListener('click', () => {
      if (this.d.isBlocked()) return;
      this.pick(hit, card, provider);
    });
    return card;
  }

  /** Выбор варианта: сразу применяем, затем тихо проверяем полную ссылку. */
  private pick(hit: CoverHit, card: HTMLButtonElement, provider: CoverProvider): void {
    this.selectedUrl = hit.url;
    this.d.sections.querySelectorAll('.cover-search__card.is-selected')
      .forEach((c) => c.classList.remove('is-selected'));
    card.classList.add('is-selected');
    this.d.applyPick(hit);
    const check = (candidate: string): Promise<string> =>
      loadImage(candidate).then(
        () => candidate,
        () => Promise.reject(new Error('изображение не открылось')),
      );
    void check(hit.url)
      .catch(() => check(hit.thumb)) // полная ссылка не открылась — пробуем уменьшенную
      .then((finalUrl) => {
        if (finalUrl === hit.url) return;
        hit.url = finalUrl;
        if (this.selectedUrl === hit.url) this.d.applyPick(hit); // подставляем рабочий размер
      })
      .catch(() => {
        card.classList.remove('is-selected');
        if (this.selectedUrl === hit.url) this.selectedUrl = null;
        toast(`Обложка ${provider.name} не открылась — выберите другой вариант или файл`);
      });
  }
}

/* ---------- Два экземпляра: форма добавления и окно обложки ---------- */

const addCoverSearch = new CoverSearchBox({
  root: q<HTMLElement>('#cover-search'),
  toggle: q<HTMLButtonElement>('#cover-search-toggle'),
  clip: q<HTMLElement>('#cover-search-clip'),
  body: q<HTMLElement>('#cover-search-body'),
  query: q<HTMLInputElement>('#cover-search-query'),
  run: q<HTMLButtonElement>('#cover-search-run'),
  sections: q<HTMLElement>('#cover-search-sections'),
  note: q<HTMLElement>('#cover-search-note'),
  getContextQuery: () => {
    const artist = artistInput.value.trim().replace(/\s+/g, ' ');
    const title = titleInput.value.trim().replace(/\s+/g, ' ');
    return artist && title ? `${artist} ${title}` : null;
  },
  applyPick: (hit) => {
    window.clearTimeout(coverUrlTimer);
    coverFile.value = '';
    coverUrl.value = hit.url;
    clearCoverUrlError();
    applyCover(hit.url);
    // подтверждение выбора: миниатюра мягко вспыхивает лавандовым
    coverPick.classList.remove('is-fresh-pick');
    void coverPick.offsetWidth;
    coverPick.classList.add('is-fresh-pick');
    window.setTimeout(() => coverPick.classList.remove('is-fresh-pick'), 1300);
  },
  isBlocked: () => addPending,
});

const dlgCoverSearch = new CoverSearchBox({
  root: q<HTMLElement>('#album-cover-search'),
  toggle: q<HTMLButtonElement>('#album-cover-search-toggle'),
  clip: q<HTMLElement>('#album-cover-search-clip'),
  body: q<HTMLElement>('#album-cover-search-body'),
  query: q<HTMLInputElement>('#album-cover-search-query'),
  run: q<HTMLButtonElement>('#album-cover-search-run'),
  sections: q<HTMLElement>('#album-cover-search-sections'),
  note: q<HTMLElement>('#album-cover-search-note'),
  getContextQuery: () => {
    const al = albums.find((a) => a.id === editingCoverAlbumId);
    if (!al) return null;
    // у сингла ищем чистое название без фита-гостя — он и так в артисте
    const title = al.kind === 'single' ? singleDisplayTitle(al) : al.title;
    return `${al.artist} ${title}`.replace(/\s+/g, ' ').trim() || null;
  },
  applyPick: (hit) => {
    window.clearTimeout(albumCoverUrlTimer);
    albumCoverRequest += 1; // поздние превью файла/ссылки больше не применяются
    albumCoverFile.value = '';
    albumCoverUrl.value = hit.url;
    albumCoverDraft = hit.url;
    albumCoverPreparing = false;
    showAlbumCoverError();
    albumCoverPreview.src = hit.url;
    // мягкая смена предпросмотра: прежняя картинка растворяется в новой
    albumCoverPreview.classList.remove('is-swap');
    void albumCoverPreview.offsetWidth;
    albumCoverPreview.classList.add('is-swap');
    updateAlbumCoverControls();
  },
  isBlocked: () => albumCoverSaving || albumCoverClosing || !albumCoverDialog.open,
});


/* ==========================================================================
   ТЕКСТЫ ПЕСЕН — GENIUS
   Альбом: значок у каждого трека (серый → жёлтый), текст раскрывается
   в секции под списком треков. Сингл: «пластинка» — диск вращается, пока
   идёт поиск, текст печатается посимвольно; поиск запускается при входе.
   Найденная песня запоминается в базе (tracks.genius_song_id /
   albums.genius_song_id): автопоиск пинит уверенное совпадение от любого
   участника, ручная замена — только админ.

   Текст песни получают через /api/genius/*: в проде это worker.js
   (Cloudflare), в превью — server.py. Прокси ищет через официальный API
   и достаёт текст со страницы genius.com (браузеру она недоступна из-за
   CORS), а токен Genius хранит на сервере.

   Точный подбор: название трека чистится от фитов и скобок («(feat. …)»,
   «- Remake 2019»), артист берётся до первого разделителя совместки;
   кандидаты скорятся по вхождению нормализованных названий и артиста;
   «уверено» = совпали обе части. Не уверены — форма «не та песня?»
   со списком кандидатов и ручной ссылкой.
   ========================================================================== */

/* Фирменный знак Genius в кружке: тот же трассированный глиф «G in Genius»,
   что и у провайдера обложек (Wikimedia Commons, public domain), на подложке. */
const GENIUS_MARK_SVG = '<svg class="genius-mark" viewBox="0 0 24 24" aria-hidden="true">' + '<circle class="genius-mark__bg" cx="12" cy="12" r="10.4"/><g class="genius-mark__ink" transform="translate(12 12) scale(0.76) translate(-12 -12)"><path d="M17.58 19.48 16.0 20.4 14.46 20.96 13.28 21.22 11.13 21.42 9.29 21.17 7.34 20.6 5.7 19.79 3.8 18.3 3.8 18.04 4.11 17.94 4.93 18.3 6.93 18.71 8.98 18.76 10.82 18.5 12.61 17.94 14.0 17.28 16.0 15.84 16.97 14.87 18.15 13.28 18.97 11.69 19.43 10.36 19.79 8.57 19.84 6.52 19.58 4.68 19.02 3.04 19.12 2.78 19.38 2.78 20.66 4.32 21.68 6.26 22.24 8.21 22.5 9.8 22.5 10.98 22.09 13.23 21.68 14.46 21.01 15.84 19.63 17.74 18.4 18.91ZM4.42 10.98 4.52 11.95 4.83 12.77 4.73 13.08 4.37 13.02 3.24 12.05 2.63 11.28 2.01 10.16 1.65 9.08 1.5 7.95 1.6 6.21 1.81 5.39 2.47 4.01 3.24 2.99 3.65 2.58 6.37 2.58 6.47 2.78 6.47 5.39 5.5 6.52 4.73 8.11 4.42 9.49ZM9.7 7.75 10.67 7.29 11.39 6.26 11.49 5.8 11.49 2.83 11.64 2.58 13.69 2.58 14.51 3.75 15.12 5.34 15.02 5.85 14.1 5.9 13.95 8.72 13.49 9.54 12.72 10.16 11.9 10.41 11.13 10.41 10.0 9.95 9.23 9.08 8.98 8.31 9.08 7.9Z"/></g>' + '</svg>';

const GENIUS_STAGE_TEXT: Record<string, string> = {
  network: 'network — запрос не выполнен (нет сети, прокси недоступен или Genius не отвечает)',
  timeout: 'timeout — ответ не пришёл за 20 с',
  parse: 'parse — ответ получен, но текст в нём не найден',
};

class GeniusError extends Error {
  constructor(readonly stage: 'network' | 'timeout' | 'parse', message: string) {
    super(message);
  }
}

interface GeniusSongInfo {
  id: string; title: string; artist: string; url: string;
  lyricsState: string | null; text: string;
}

const geniusSearchCache = new Map<string, Array<{ id: string; title: string; artist: string; url: string; lyricsState: string | null }>>();
const geniusLyricsCache = new Map<string, GeniusSongInfo>();

async function geniusApi<T>(path: string, params: Record<string, string>): Promise<T> {
  const qs = new URLSearchParams(params).toString();
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 20000);
  try {
    const response = await fetch(`/api/genius/${path}?${qs}`, { signal: controller.signal, headers: { accept: 'application/json' } });
    const data = (await response.json().catch(() => null)) as { error?: string } | null;
    if (!response.ok) {
      throw new GeniusError('network', (data as { error?: string } | null)?.error || `прокси ответил ${response.status}`);
    }
    return data as T;
  } catch (err) {
    if (err instanceof GeniusError) throw err;
    if ((err as { name?: string } | null)?.name === 'AbortError') {
      throw new GeniusError('timeout', 'ответ не пришёл за 20 с');
    }
    throw new GeniusError('network', messageOf(err));
  } finally {
    window.clearTimeout(timer);
  }
}

async function geniusSearchSongs(query: string): Promise<Array<{ id: string; title: string; artist: string; url: string; lyricsState: string | null }>> {
  const cachedHits = geniusSearchCache.get(query);
  if (cachedHits) return cachedHits;
  const data = await geniusApi<{ response?: { hits?: Array<{ type?: string; result?: Record<string, unknown> }> } }>('search', { q: query });
  const hits = (data.response?.hits ?? [])
    .filter((h) => h.type === 'song' && h.result)
    .map((h) => {
      const r = h.result as Record<string, unknown>;
      return {
        id: String(r.id),
        title: typeof r.title === 'string' ? r.title : '',
        artist: (r.primary_artist as { name?: unknown } | null)?.name as string | undefined ?? '',
        url: typeof r.url === 'string' ? r.url : '',
        lyricsState: typeof r.lyrics_state === 'string' ? r.lyrics_state : null,
      };
    });
  geniusSearchCache.set(query, hits);
  return hits;
}

async function geniusFetchSong(id: string): Promise<GeniusSongInfo> {
  const cachedSong = geniusLyricsCache.get(id);
  if (cachedSong) return cachedSong;
  const data = await geniusApi<{ song?: Record<string, unknown> }>('lyrics', { id });
  const song = data.song;
  if (!song) throw new GeniusError('parse', 'песня не найдена');
  const parsed = {
    id: String(song.id),
    title: typeof song.title === 'string' ? song.title : '',
    artist: typeof song.artist === 'string' ? song.artist : '',
    url: typeof song.url === 'string' ? song.url : '',
    lyricsState: typeof song.lyrics_state === 'string' ? song.lyrics_state : null,
    text: typeof song.text === 'string' ? song.text : '',
  };
  geniusLyricsCache.set(id, parsed);
  return parsed;
}

/* --- точный подбор запроса --- */

const GENIUS_BRACKETS_RE = /[(\[{][^)\]}]*[)\]}]/g;

function geniusCleanTitle(raw: string): string {
  let t = raw.replace(GENIUS_BRACKETS_RE, ' ');
  t = t.replace(/\s*\b(?:feat|ft)\b\.?\s+.*$/i, ' ');
  t = t.replace(/\s*-\s*(?:remake|remaster(?:ed)?|version|edit|demo|mix)\b.*$/i, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

function geniusMainArtist(raw: string): string {
  return raw.split(/\s*,\s*|\s+&\s+|\s+(?:feat|ft)\.?\s+/i)[0].trim();
}

function geniusNorm(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Оценка кандидата: совпало нормализованное название (полностью/частично)
    и артист. «Уверенно» = есть и то и другое. */
function geniusScore(song: { title: string; artist: string }, artistQuery: string, titleQuery: string): { total: number; titleOk: boolean; artistOk: boolean } {
  const tN = geniusNorm(song.title);
  const aN = geniusNorm(song.artist);
  const tQ = geniusNorm(titleQuery);
  const aQ = geniusNorm(artistQuery);
  let titleOk = false;
  let artistOk = false;
  let total = 0;
  if (tQ && tN) {
    if (tN === tQ) { titleOk = true; total += 0.6; }
    else if (tN.includes(tQ) || tQ.includes(tN)) { titleOk = true; total += 0.45; }
    else if (tQ.length >= 4 && (tN.includes(tQ.slice(0, Math.ceil(tQ.length * 0.6))) || tQ.includes(tN.slice(0, Math.ceil(tN.length * 0.6))))) { titleOk = true; total += 0.25; }
  }
  if (aQ && aN) {
    if (aN === aQ) { artistOk = true; total += 0.4; }
    else if (aN.includes(aQ) || aQ.includes(aN)) { artistOk = true; total += 0.3; }
  }
  if (titleOk && artistOk && tN === tQ && aN === aQ) total += 0.1;
  return { total, titleOk, artistOk };
}

/* --- запоминание выбранной песни --- */

/** Локальные подстановки до перезагрузки (участники без прав админа). */
const geniusLocalOverride = new Map<string, string>();

function geniusPinnedId(kind: 'track' | 'single', refId: string): string | null {
  const override = geniusLocalOverride.get(`${kind}:${refId}`);
  if (override) return override;
  const row = kind === 'track' ? tracks.find((t) => t.id === refId) : albums.find((a) => a.id === refId);
  return row ? ((row as UiTrack).geniusId ?? (row as UiAlbum).geniusId ?? null) : null;
}

async function geniusPin(kind: 'track' | 'single', refId: string, songId: string | null): Promise<void> {
  if (CLOUD) {
    const table = kind === 'track' ? 'tracks' : 'albums';
    const { error } = await getSB().from(table)
      .update({ genius_song_id: songId ? Number(songId) : null })
      .eq('id', refId);
    if (error) throw error;
    await refreshData();
    return;
  }
  if (kind === 'track') {
    tracks = tracks.map((t) => (t.id === refId ? { ...t, geniusId: songId } : t));
    saveLocalTracks();
  } else {
    albums = albums.map((a) => (a.id === refId ? { ...a, geniusId: songId } : a));
    saveLocalAlbums();
  }
}

/* ---------- DOM: панель альбома и пластинка сингла ---------- */

const lyricsPanel = q<HTMLElement>('#lyrics-panel');
const lyricsSong = q<HTMLElement>('#lyrics-song');
const lyricsArtist = q<HTMLElement>('#lyrics-artist');
const lyricsLink = q<HTMLAnchorElement>('#lyrics-link');
const lyricsReplaceBtn = q<HTMLButtonElement>('#lyrics-replace-btn');
const lyricsClose = q<HTMLButtonElement>('#lyrics-close');
const lyricsState = q<HTMLElement>('#lyrics-state');
const lyricsSkeleton = q<HTMLElement>('#lyrics-skeleton');
const lyricsFail = q<HTMLElement>('#lyrics-fail');
const lyricsFailToggle = q<HTMLButtonElement>('#lyrics-fail-toggle');
const lyricsReport = q<HTMLElement>('#lyrics-report');
const lyricsCopy = q<HTMLButtonElement>('#lyrics-copy');
const lyricsText = q<HTMLElement>('#lyrics-text');
const lyricsFix = q<HTMLFormElement>('#lyrics-fix');
const lyricsCands = q<HTMLElement>('#lyrics-cands');
const lyricsUrl = q<HTMLInputElement>('#lyrics-url');
const lyricsUrlError = q<HTMLElement>('#lyrics-url-error');
const lyricsFixCancel = q<HTMLButtonElement>('#lyrics-fix-cancel');
const lyricsFixSave = q<HTMLButtonElement>('#lyrics-fix-save');
const lyricsFixNote = q<HTMLElement>('#lyrics-fix-note');

const vinylSection = q<HTMLElement>('#vinyl-section');
const vinylDisc = q<HTMLElement>('#vinyl-disc');
const vinylArt = q<HTMLImageElement>('#vinyl-art');
const vinylPin = q<HTMLButtonElement>('#vinyl-pin');
const vinylSong = q<HTMLElement>('#vinyl-song');
const vinylArtist = q<HTMLElement>('#vinyl-artist');
const vinylLink = q<HTMLAnchorElement>('#vinyl-link');
const vinylReplaceBtn = q<HTMLButtonElement>('#vinyl-replace-btn');
const vinylClip = q<HTMLElement>('#vinyl-clip');
const vinylState = q<HTMLElement>('#vinyl-state');
const vinylSkeleton = q<HTMLElement>('#vinyl-skeleton');
const vinylFail = q<HTMLElement>('#vinyl-fail');
const vinylFailToggle = q<HTMLButtonElement>('#vinyl-fail-toggle');
const vinylReport = q<HTMLElement>('#vinyl-report');
const vinylCopy = q<HTMLButtonElement>('#vinyl-copy');
const vinylText = q<HTMLElement>('#vinyl-text');
const vinylFix = q<HTMLFormElement>('#vinyl-fix');
const vinylCands = q<HTMLElement>('#vinyl-cands');
const vinylUrl = q<HTMLInputElement>('#vinyl-url');
const vinylUrlError = q<HTMLElement>('#vinyl-url-error');
const vinylFixCancel = q<HTMLButtonElement>('#vinyl-fix-cancel');
const vinylFixSave = q<HTMLButtonElement>('#vinyl-fix-save');
const vinylFixNote = q<HTMLElement>('#vinyl-fix-note');

interface GeniusScreenUi {
  song: HTMLElement;
  artist: HTMLElement;
  link: HTMLAnchorElement;
  replaceBtn: HTMLButtonElement;
  state: HTMLElement;
  skeleton: HTMLElement;
  fail: HTMLElement;
  failToggle: HTMLButtonElement;
  report: HTMLElement;
  copy: HTMLButtonElement;
  text: HTMLElement;
  fix: HTMLFormElement;
  cands: HTMLElement;
  url: HTMLInputElement;
  urlError: HTMLElement;
  fixCancel: HTMLButtonElement;
  fixSave: HTMLButtonElement;
  fixNote: HTMLElement;
  typewriter: boolean;
}

const albumLyricsUi: GeniusScreenUi = {
  song: lyricsSong, artist: lyricsArtist, link: lyricsLink, replaceBtn: lyricsReplaceBtn,
  state: lyricsState, skeleton: lyricsSkeleton, fail: lyricsFail, failToggle: lyricsFailToggle, report: lyricsReport,
  copy: lyricsCopy, text: lyricsText, fix: lyricsFix, cands: lyricsCands, url: lyricsUrl,
  urlError: lyricsUrlError, fixCancel: lyricsFixCancel, fixSave: lyricsFixSave, fixNote: lyricsFixNote,
  typewriter: false,
};

const vinylLyricsUi: GeniusScreenUi = {
  song: vinylSong, artist: vinylArtist, link: vinylLink, replaceBtn: vinylReplaceBtn,
  state: vinylState, skeleton: vinylSkeleton, fail: vinylFail, failToggle: vinylFailToggle, report: vinylReport,
  copy: vinylCopy, text: vinylText, fix: vinylFix, cands: vinylCands, url: vinylUrl,
  urlError: vinylUrlError, fixCancel: vinylFixCancel, fixSave: vinylFixSave, fixNote: vinylFixNote,
  typewriter: true,
};

/* ---------- общий движок ---------- */

interface GeniusRun {
  kind: 'track' | 'single';
  refId: string;
  artist: string;
  title: string;
  ui: GeniusScreenUi;
}

let geniusSeq = 0;
let geniusActiveKey: string | null = null;
let geniusTypeTimer: number | undefined;

function geniusReportText(run: GeniusRun, err: GeniusError, detail: string): string {
  const build = document.querySelector<HTMLScriptElement>('script[src*="app.js"]')?.getAttribute('src') ?? 'app.js';
  return [
    'Текст песни — отчёт об ошибке',
    `источник: Genius (${run.kind === 'track' ? 'трек' : 'сингл'})`,
    `искали: «${run.artist} ${run.title}»`,
    `этап: ${GENIUS_STAGE_TEXT[err.stage]}`,
    `сообщение: ${err.message}`,
    detail ? `детали: ${detail}` : '',
    `время: ${new Date().toISOString()}`,
    `страница: ${location.href}`,
    `сборка: ${build}`,
  ].filter(Boolean).join('\n');
}

function geniusSetState(ui: GeniusScreenUi, text: string): void {
  ui.state.textContent = text;
  const searching = text === 'ищем текст на Genius…';
  ui.state.classList.toggle('is-searching', searching);
  ui.skeleton.hidden = !searching;
}

function geniusShowError(ui: GeniusScreenUi, report: string): void {
  ui.fail.hidden = false;
  ui.report.textContent = report;
  ui.report.hidden = true;
  ui.copy.hidden = true;
  ui.failToggle.textContent = 'показать детали';
}

function geniusResetUi(ui: GeniusScreenUi): void {
  window.clearInterval(geniusTypeTimer);
  ui.song.textContent = '';
  ui.artist.textContent = '';
  ui.link.hidden = true;
  ui.link.removeAttribute('href');
  ui.state.textContent = '';
  ui.fail.hidden = true;
  ui.report.textContent = '';
  ui.report.hidden = true;
  ui.copy.hidden = true;
  ui.text.hidden = true;
  ui.text.textContent = '';
  ui.text.classList.remove('is-typing');
  ui.fix.hidden = true;
  ui.cands.innerHTML = '';
  ui.url.value = '';
  ui.urlError.textContent = '';
  ui.replaceBtn.hidden = !isAdmin();
  ui.skeleton.hidden = true;
  lyricsPanel.classList.remove('is-searching', 'is-found');
  vinylSection.classList.remove('is-searching', 'is-found');
  vinylDisc.classList.remove('is-landing');
  vinylPin.classList.remove('is-dropping');
}

/** Печать текста посимвольно (сингл): быстро, с бегущим курсором. */
function geniusTypeText(ui: GeniusScreenUi, text: string): void {
  window.clearInterval(geniusTypeTimer);
  ui.text.hidden = false;
  ui.text.classList.remove('is-typing');
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    ui.text.textContent = text;
    return;
  }
  if (!ui.typewriter) {
    // альбом: строки появляются каскадом — подъём с расфокусом, шаг 42 мс
    const frag = document.createDocumentFragment();
    text.split('\n').forEach((line, i) => {
      const el = document.createElement('span');
      el.className = 'lyrics__line';
      el.textContent = line.length ? line : '\u00A0';
      el.style.animationDelay = `${Math.min(i * 42, 1900)}ms`;
      frag.appendChild(el);
    });
    ui.text.textContent = '';
    ui.text.appendChild(frag);
    return;
  }
  ui.text.textContent = '';
  ui.text.classList.add('is-typing');
  let i = 0;
  geniusTypeTimer = window.setInterval(() => {
    i = Math.min(text.length, i + 22);
    ui.text.textContent = text.slice(0, i);
    if (i >= text.length) {
      window.clearInterval(geniusTypeTimer);
      ui.text.classList.remove('is-typing');
    }
  }, 16);
}

function geniusRenderSong(run: GeniusRun, song: GeniusSongInfo): void {
  const ui = run.ui;
  geniusSetState(ui, song.text ? '' : 'на Genius текст этой песни пока не заполнен');
  ui.song.textContent = song.title;
  ui.artist.textContent = song.artist;
  if (song.url) {
    ui.link.href = song.url;
    ui.link.hidden = false;
  }
  if (song.text) geniusTypeText(ui, song.text);
  const surface = run.kind === 'single' ? vinylSection : lyricsPanel;
  surface.classList.add('is-found');
  if (run.kind === 'single') {
    vinylDisc.classList.add('is-landing');
    vinylPin.classList.add('is-dropping');
  }
}

/** Список кандидатов в форме «не та песня?». */
function geniusRenderCandidates(run: GeniusRun, candidates: Array<{ id: string; title: string; artist: string }>): void {
  const ui = run.ui;
  ui.cands.innerHTML = '';
  for (const song of candidates.slice(0, 6)) {
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'lyrics__cand';
    chip.innerHTML = `<span class="lyrics__cand-title">${esc(song.title)}</span><span class="lyrics__cand-artist">${esc(song.artist)}</span>`;
    chip.addEventListener('click', () => {
      void geniusApplySong(run, song.id, song);
    });
    ui.cands.appendChild(chip);
  }
  if (!candidates.length) ui.cands.innerHTML = '<p class="cover-pick__note">кандидатов не нашлось — вставьте ссылку на страницу песни</p>';
}

function geniusOpenFix(run: GeniusRun, candidates: Array<{ id: string; title: string; artist: string }>): void {
  const ui = run.ui;
  geniusRenderCandidates(run, candidates);
  ui.fix.hidden = false;
  ui.fixNote.textContent = isAdmin()
    ? 'подставленная песня запомнится в базе для всех'
    : 'замену запомнит только админ — остальным подстановка откроется до перезагрузки';
}

function geniusIdFromUrl(raw: string): string | null {
  try {
    const url = new URL(raw.trim());
    if (!/(^|\.)genius\.com$/i.test(url.hostname)) return null;
    const m = url.pathname.match(/(\d+)(?!.*\d)/); // последнее число в пути (…-9100-lyrics)
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

/** Подставить выбранную песню: сразу показать текст; админ — запоминает в базе. */
async function geniusApplySong(run: GeniusRun, songId: string, hint?: { title: string; artist: string }): Promise<void> {
  const ui = run.ui;
  ui.fixSave.classList.add('is-loading');
  geniusSetState(ui, 'проверяем песню…');
  try {
    const song = await geniusFetchSong(songId);
    geniusLocalOverride.set(`${run.kind}:${run.refId}`, song.id);
    if (isAdmin()) {
      try {
        await geniusPin(run.kind, run.refId, song.id);
      } catch (err) {
        toast(messageOf(err)); // текст всё равно показан; запоминание можно повторить
      }
    }
    geniusRenderSong(run, song);
    ui.fix.hidden = true;
    toast(run.kind === 'track' ? 'Текст подставлен' : 'Текст подставлен на пластинку');
  } catch (err) {
    geniusSetState(ui, '');
    ui.urlError.textContent = err instanceof GeniusError ? err.message : messageOf(err);
  } finally {
    ui.fixSave.classList.remove('is-loading');
    void hint;
  }
}

/** Основной сценарий: закреплённая песня → мгновенно; иначе поиск → скоринг →
    уверенное совпадение пинится и открывается; иначе — форма «не та песня?». */
async function geniusRun(run: GeniusRun): Promise<void> {
  const ui = run.ui;
  geniusSeq += 1;
  const seq = geniusSeq;
  geniusActiveKey = `${run.kind}:${run.refId}`;
  geniusResetUi(ui);
  geniusSetState(ui, 'ищем текст на Genius…');
  if (run.kind === 'single') {
    vinylSection.hidden = false;
    vinylPin.classList.remove('is-active');
    vinylPin.setAttribute('aria-expanded', 'true');
    vinylClip.classList.add('is-open');
    vinylSection.classList.add('is-searching');
    vinylDisc.classList.add('is-searching');
  } else {
    lyricsPanel.classList.add('is-searching');
  }
  const settle = (): void => {
    if (run.kind === 'single') {
      vinylSection.classList.remove('is-searching');
      vinylDisc.classList.remove('is-searching');
    } else {
      lyricsPanel.classList.remove('is-searching');
    }
    ui.skeleton.hidden = true;
    ui.state.classList.remove('is-searching');
  };

  try {
    const pinned = geniusPinnedId(run.kind, run.refId);
    if (pinned) {
      const song = await geniusFetchSong(pinned);
      if (seq !== geniusSeq) return;
      settle();
      geniusRenderSong(run, song);
      if (run.kind === 'single') vinylPin.classList.add('is-active');
      return;
    }

    const query = `${geniusMainArtist(run.artist)} ${geniusCleanTitle(run.title)}`.trim();
    const hits = await geniusSearchSongs(query);
    if (seq !== geniusSeq) return;
    const scored = hits
      .map((song) => ({ song, ...geniusScore(song, run.artist, run.title) }))
      .sort((a, b) => b.total - a.total);
    const best = scored[0];
    if (best && best.titleOk && best.artistOk) {
      const songId = best.song.id;
      try {
        await geniusPin(run.kind, run.refId, songId); // уверенное совпадение — помним для всех
        if (seq !== geniusSeq) return;
      } catch { /* не запомнилось — текст всё равно откроем */ }
      const song = await geniusFetchSong(songId);
      if (seq !== geniusSeq) return;
      settle();
      geniusRenderSong(run, song);
      if (run.kind === 'single') vinylPin.classList.add('is-active');
      return;
    }
    settle();
    geniusSetState(ui, 'не уверены, что нашли именно эту песню — проверьте варианты');
    geniusOpenFix(run, scored.map((s) => s.song));
  } catch (err) {
    if (seq !== geniusSeq) return;
    settle();
    const searchErr = err instanceof GeniusError ? err : new GeniusError('network', messageOf(err));
    geniusSetState(ui, `не получилось: ${searchErr.message}`);
    geniusShowError(ui, geniusReportText(run, searchErr, `эндпоинт: /api/genius/`));
  }
}

/* ---------- альбом: значок у трека + панель под списком ---------- */

function toggleTrackGenius(trackId: string): void {
  const track = tracks.find((t) => t.id === trackId);
  if (!track || !currentAlbumId) return;
  const key = `track:${trackId}`;
  if (geniusActiveKey === key && !lyricsPanel.hidden) {
    closeLyricsPanel();
    return;
  }
  const album = currentAlbum()!;
  geniusResetUi(albumLyricsUi);
  lyricsPanel.hidden = false;
  lyricsPanel.classList.remove('is-open');
  void lyricsPanel.offsetWidth;
  lyricsPanel.classList.add('is-open');
  trackList.querySelectorAll('.track__genius.is-active').forEach((b) => b.classList.remove('is-active'));
  const btn = trackList.querySelector<HTMLElement>(`[data-id="${trackId}"] .track__genius`);
  btn?.classList.add('is-active');
  void geniusRun({
    kind: 'track', refId: trackId,
    artist: album.artist, title: track.title,
    ui: albumLyricsUi,
  });
  window.setTimeout(() => lyricsPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 120);
}

function closeLyricsPanel(): void {
  lyricsPanel.hidden = true;
  lyricsPanel.classList.remove('is-open');
  geniusActiveKey = null;
  window.clearInterval(geniusTypeTimer);
  trackList.querySelectorAll('.track__genius.is-active').forEach((b) => b.classList.remove('is-active'));
}

lyricsClose.addEventListener('click', closeLyricsPanel);
lyricsReplaceBtn.addEventListener('click', () => {
  const activeKey = geniusActiveKey;
  if (activeKey?.startsWith('track:')) {
    const track = tracks.find((t) => t.id === activeKey.slice(6));
    const album = currentAlbum();
    if (track && album) {
      geniusSetState(albumLyricsUi, 'ищем варианты…');
      void (async () => {
        try {
          const query = `${geniusMainArtist(album.artist)} ${geniusCleanTitle(track.title)}`.trim();
          const hits = await geniusSearchSongs(query);
          geniusSetState(albumLyricsUi, 'выберите правильную песню:');
          geniusOpenFix({ kind: 'track', refId: track.id, artist: album.artist, title: track.title, ui: albumLyricsUi }, hits);
        } catch (err) {
          geniusSetState(albumLyricsUi, messageOf(err));
        }
      })();
    }
  }
});
lyricsFailToggle.addEventListener('click', () => {
  const willShow = lyricsReport.hidden;
  lyricsReport.hidden = !willShow;
  lyricsCopy.hidden = !willShow;
  lyricsFailToggle.textContent = willShow ? 'скрыть детали' : 'показать детали';
});
lyricsCopy.addEventListener('click', () => {
  const ok = copyTextToClipboard(lyricsReport.textContent ?? '');
  void Promise.resolve(ok).then((copied) => toast(copied ? 'Отчёт скопирован — вставьте его в сообщение разработчику' : 'Не удалось скопировать: выделите текст деталей и скопируйте вручную (Ctrl+C)'));
});
lyricsFixCancel.addEventListener('click', () => { lyricsFix.hidden = true; lyricsUrlError.textContent = ''; });
lyricsFix.addEventListener('submit', (e) => {
  e.preventDefault();
  const fromUrl = geniusIdFromUrl(lyricsUrl.value);
  if (!fromUrl) {
    lyricsUrlError.textContent = 'нужна ссылка на страницу песни вида https://genius.com/…';
    return;
  }
  const track = tracks.find((t) => t.id === geniusActiveKey?.slice(6));
  const album = currentAlbum();
  if (track && album) void geniusApplySong({ kind: 'track', refId: track.id, artist: album.artist, title: track.title, ui: albumLyricsUi }, fromUrl);
});

/* ---------- сингл: пластинка с вращением и посимвольным текстом ---------- */

function resetVinyl(): void {
  window.clearInterval(geniusTypeTimer);
  vinylSection.hidden = true;
  vinylSection.classList.remove('is-searching', 'is-found');
  vinylDisc.classList.remove('is-searching', 'is-landing');
  vinylPin.classList.remove('is-dropping');
  vinylSkeleton.hidden = true;
  vinylPin.classList.remove('is-active', 'is-open');
  vinylPin.setAttribute('aria-expanded', 'false');
  vinylClip.classList.remove('is-open');
}

vinylPin.addEventListener('click', () => {
  const isOpen = vinylClip.classList.toggle('is-open');
  vinylPin.setAttribute('aria-expanded', String(isOpen));
});

vinylFailToggle.addEventListener('click', () => {
  const willShow = vinylReport.hidden;
  vinylReport.hidden = !willShow;
  vinylCopy.hidden = !willShow;
  vinylFailToggle.textContent = willShow ? 'скрыть детали' : 'показать детали';
});
vinylCopy.addEventListener('click', () => {
  const ok = copyTextToClipboard(vinylReport.textContent ?? '');
  void Promise.resolve(ok).then((copied) => toast(copied ? 'Отчёт скопирован — вставьте его в сообщение разработчику' : 'Не удалось скопировать: выделите текст деталей и скопируйте вручную (Ctrl+C)'));
});
vinylReplaceBtn.addEventListener('click', () => {
  const s = currentSingle();
  if (!s) return;
  geniusSetState(vinylLyricsUi, 'ищем варианты…');
  void (async () => {
    try {
      const query = `${geniusMainArtist(s.artist)} ${geniusCleanTitle(singleDisplayTitle(s))}`.trim();
      const hits = await geniusSearchSongs(query);
      geniusSetState(vinylLyricsUi, 'выберите правильную песню:');
      geniusOpenFix({ kind: 'single', refId: s.id, artist: s.artist, title: singleDisplayTitle(s), ui: vinylLyricsUi }, hits);
    } catch (err) {
      geniusSetState(vinylLyricsUi, messageOf(err));
    }
  })();
});
vinylFixCancel.addEventListener('click', () => { vinylFix.hidden = true; vinylUrlError.textContent = ''; });
vinylFix.addEventListener('submit', (e) => {
  e.preventDefault();
  const fromUrl = geniusIdFromUrl(vinylUrl.value);
  if (!fromUrl) {
    vinylUrlError.textContent = 'нужна ссылка на страницу песни вида https://genius.com/…';
    return;
  }
  const s = currentSingle();
  if (s) void geniusApplySong({ kind: 'single', refId: s.id, artist: s.artist, title: singleDisplayTitle(s), ui: vinylLyricsUi }, fromUrl);
});

/** Поиск текста запускается сразу при входе на сингл. */
function startVinylLyrics(single: UiAlbum): void {
  resetVinyl();
  vinylSection.hidden = false;
  const cover = coverSrc(single);
  if (cover && !cover.startsWith('data:image/svg')) vinylArt.src = cover;
  void geniusRun({
    kind: 'single', refId: single.id,
    artist: single.artist, title: singleDisplayTitle(single),
    ui: vinylLyricsUi,
  });
}

/* ==========================================================================
   ДОБАВЛЕНИЕ АЛЬБОМА
   ========================================================================== */

let addPending = false;
let pendingCover: string | null = null;
let coverUrlTimer: number | undefined;

function clearAddErrors(): void {
  addError.textContent = '';
  addError.classList.remove('is-visible');
  titleError.textContent = '';
  titleError.classList.remove('is-visible');
}
function showAddError(text: string): void {
  addError.textContent = text;
  addError.classList.add('is-visible');
}
function showTitleError(text: string): void {
  titleError.textContent = text;
  titleError.classList.add('is-visible');
}

function artistNames(): string[] {
  const set = new Set<string>();
  for (const a of albums) set.add(a.artist.trim());
  set.delete('');
  return [...set].sort((a, b) => a.localeCompare(b, 'ru'));
}

function refreshDupHint(): void {
  const artist = artistInput.value.trim();
  const title = titleInput.value.trim();
  if (artist && title) {
    const dup = albums.some(
      (a) => a.kind === addKind
        && a.artist.toLowerCase() === artist.toLowerCase()
        && a.title.toLowerCase() === title.toLowerCase(),
    );
    if (dup) showTitleError(`такой ${addKind === 'single' ? 'сингл' : 'альбом'} у этого артиста уже есть`);
    else {
      titleError.textContent = '';
      titleError.classList.remove('is-visible');
    }
  } else {
    titleError.textContent = '';
    titleError.classList.remove('is-visible');
  }
}

function updateArtistList(): void {
  const q0 = artistInput.value.trim().toLowerCase();
  const names = artistNames();
  const matches = q0 ? names.filter((n) => n.toLowerCase().includes(q0)) : names;

  artistList.innerHTML = '';

  if (matches.length === 0 && q0) {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'combo__item combo__item--new';
    btn.innerHTML = `<span class="combo__name">новый артист: «${esc(artistInput.value.trim())}»</span>`;
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      artistList.hidden = true;
      markArtistPicked();
    });
    li.appendChild(btn);
    artistList.appendChild(li);
  } else {
    for (const n of matches.slice(0, 6)) {
      const li = document.createElement('li');
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'combo__item';
      btn.innerHTML = `<span class="combo__name">${esc(n)}</span><span class="combo__tag">из коллекции</span>`;
      btn.addEventListener('pointerdown', (e) => {
        e.preventDefault();
        selectArtist(n);
      });
      li.appendChild(btn);
      artistList.appendChild(li);
    }
  }

  artistList.hidden = artistList.children.length === 0;
}

function selectArtist(name: string): void {
  artistInput.value = name;
  artistList.hidden = true;
  markArtistPicked();
  refreshDupHint();
  addCoverSearch.syncContext(); // значение выбрано из подсказок — обновляем авто-запрос
  titleInput.focus();
}

function markArtistPicked(): void {
  artistField.classList.remove('pulse', 'is-picked');
  void artistField.offsetWidth;
  artistField.classList.add('is-picked', 'pulse');
}

const ARTIST_FEAT_HINT = 'фит или совместку указывайте прямо здесь: «Артист & Гость» или «Артист feat. Гость» — гость попадёт в блок артиста';

/* подсказка у поля артиста (режим сингла): обычная — про синтаксис фита,
   живая — подтверждает распознанного гостя, пока его печатают */
function updateArtistFeatNote(): void {
  if (addKind !== 'single') {
    artistNote.hidden = true;
    return;
  }
  const raw = artistInput.value;
  const m = FEAT_RE.exec(raw);
  if (m) {
    const main = raw.slice(0, m.index ?? 0).trim();
    const guest = raw.slice((m.index ?? 0) + m[0].length).replace(/[),.\s]+$/, '').trim();
    if (main && guest) {
      artistNote.textContent = `фит: ${guest} — гость будет в блоке артиста сингла`;
      artistNote.hidden = false;
      return;
    }
  }
  artistNote.textContent = ARTIST_FEAT_HINT;
  artistNote.hidden = false;
}

artistInput.addEventListener('input', () => {
  artistField.classList.remove('is-picked');
  updateArtistList();
  updateArtistFeatNote();
  clearAddErrors();
  refreshDupHint();
  addCoverSearch.syncContext(); // артист и название заполнены — авто-поиск обложек
});
artistInput.addEventListener('focus', () => updateArtistList());
artistInput.addEventListener('blur', () => {
  window.setTimeout(() => { artistList.hidden = true; }, 120);
});
document.addEventListener('click', (e) => {
  if (!artistBox.contains(e.target as Node)) artistList.hidden = true;
});

titleInput.addEventListener('input', () => {
  clearAddErrors();
  refreshDupHint();
  addCoverSearch.syncContext(); // артист и название заполнены — авто-поиск обложек
});
yearInput.addEventListener('input', () => clearAddErrors());

function normalizeArtist(raw: string): string {
  const lower = raw.toLowerCase();
  const existing = artistNames().find((n) => n.toLowerCase() === lower);
  return existing ?? raw;
}

/* обложка */
function applyCover(src: string): void {
  pendingCover = src;
  coverImg.src = src;
  coverPick.classList.add('has-cover');
}

function clearCoverUrlError(): void {
  coverUrlError.textContent = '';
  coverUrlError.classList.remove('is-visible');
}
function showCoverUrlError(text: string): void {
  coverUrlError.textContent = text;
  coverUrlError.classList.add('is-visible');
}

coverPick.addEventListener('click', () => coverFile.click());
coverPick.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') {
    e.preventDefault();
    coverFile.click();
  }
});

coverFile.addEventListener('change', () => {
  const file = coverFile.files?.[0];
  if (file) void handleCoverFile(file);
});

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('read error'));
    fr.readAsDataURL(file);
  });
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    const timer = window.setTimeout(() => {
      img.onload = img.onerror = null;
      img.src = '';
      reject(new Error('Изображение загружается слишком долго. Попробуйте другой файл или ссылку.'));
    }, 15000);
    img.onload = () => { window.clearTimeout(timer); resolve(img); };
    img.onerror = () => {
      window.clearTimeout(timer);
      reject(new Error('Не удалось загрузить изображение. Проверьте файл или прямую ссылку.'));
    };
    img.src = src;
  });
}

/* Одинаковая подготовка файла при создании альбома и при смене обложки. */
async function prepareCoverFile(file: File): Promise<string> {
  if (!file.type.startsWith('image/')) throw new Error('Нужен файл изображения');
  if (file.size > 10 * 1024 * 1024) throw new Error('Изображение слишком большое. Максимум — 10 МБ.');
  try {
    const img = await loadImage(await readFileAsDataURL(file));
    const scale = Math.min(1, 900 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.width * scale));
    canvas.height = Math.max(1, Math.round(img.height * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('no ctx');
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', 0.85);
  } catch {
    throw new Error('Не удалось прочитать изображение. Выберите другой файл.');
  }
}

async function uploadCover(dataUrl: string): Promise<string> {
  const storage = getSB().storage.from('covers');
  const blob = dataUrlToBlob(dataUrl);
  // Новый URL для каждой версии: CDN/браузер не покажет старую обложку из кэша.
  const path = 'cover-' + crypto.randomUUID() + '.jpg';
  const { error } = await storage.upload(path, blob, { contentType: blob.type, upsert: false });
  if (error) throw new Error('Не удалось загрузить обложку в хранилище: ' + messageOf(error));
  return storage.getPublicUrl(path).data.publicUrl;
}

async function handleCoverFile(file: File): Promise<void> {
  try {
    applyCover(await prepareCoverFile(file));
    coverUrl.value = '';
    clearCoverUrlError();
    addCoverSearch.clearSelection(); // источником стал файл — подсветка варианта не нужна
  } catch (err) {
    toast(messageOf(err));
  }
}

coverUrl.addEventListener('input', () => {
  window.clearTimeout(coverUrlTimer);
  clearCoverUrlError();
  const url = coverUrl.value.trim();
  if (!url) return;
  coverUrlTimer = window.setTimeout(() => void tryCoverUrl(url), 400);
});

async function tryCoverUrl(url: string): Promise<void> {
  if (!/^https?:\/\//i.test(url)) {
    showCoverUrlError('нужна ссылка вида http(s)://…');
    return;
  }
  try {
    await loadImage(url);
    applyCover(url);
    coverFile.value = '';
  } catch {
    showCoverUrlError('не удалось загрузить изображение по ссылке');
  }
}

coverRemove.addEventListener('click', (e) => {
  e.stopPropagation();
  pendingCover = null;
  coverImg.removeAttribute('src');
  coverPick.classList.remove('has-cover');
  coverFile.value = '';
  coverUrl.value = '';
  clearCoverUrlError();
  window.clearTimeout(coverUrlTimer);
  addCoverSearch.clearSelection();
});

/* Кастомный select: фокус остаётся на combobox, стрелки перемещают активную
   опцию, Enter/Space подтверждают. Escape/Tab не меняют выбранного участника. */
let evaluatorOpen = false;
let evaluatorActiveIndex = 0;
let evaluatorCloseTimer: number | undefined;
let evaluatorValueAnimation: Animation | undefined;

function evaluatorIdentity(id: string): HTMLElement {
  const identity = document.createElement('span');
  identity.className = 'evaluator__identity';
  const avatars = document.createElement('span');
  avatars.className = 'evaluator__avatars' + (id ? '' : ' evaluator__avatars--all');
  avatars.setAttribute('aria-hidden', 'true');
  const info = profileCache.get(id);
  for (const person of info ? [info] : [...profileCache.values()]) {
    const avatar = document.createElement('span');
    avatar.className = 'evaluator__avatar';
    setAvatarEl(avatar, person);
    avatars.appendChild(avatar);
  }
  const name = document.createElement('span');
  name.className = 'evaluator__name';
  name.textContent = info?.username ?? 'Все участники';
  identity.append(avatars, name);
  return identity;
}

function evaluatorOptions(): HTMLElement[] {
  return [...evaluatorList.querySelectorAll<HTMLElement>('[role="option"]')];
}

function highlightEvaluator(index: number, scroll = false): void {
  const options = evaluatorOptions();
  evaluatorActiveIndex = Math.max(0, Math.min(index, options.length - 1));
  options.forEach((option, i) => option.classList.toggle('is-active', i === evaluatorActiveIndex));
  const active = options[evaluatorActiveIndex];
  if (active && evaluatorOpen) {
    evaluatorTrigger.setAttribute('aria-activedescendant', active.id);
    if (scroll) active.scrollIntoView({ block: 'nearest' });
  }
}

function setEvaluatorOpen(open: boolean): void {
  if (open && (evaluatorField.hidden || !isAdmin())) return;
  window.clearTimeout(evaluatorCloseTimer);
  evaluatorOpen = open;
  evaluatorPicker.classList.toggle('is-open', open);
  evaluatorField.classList.toggle('is-open', open);
  evaluatorTrigger.setAttribute('aria-expanded', String(open));
  evaluatorList.setAttribute('aria-hidden', String(!open));
  evaluatorList.inert = !open;
  if (open) {
    evaluatorField.classList.remove('is-closing');
    artistList.hidden = true;
    parentList.hidden = true;
    highlightEvaluator(evaluatorOptions().findIndex((option) => option.dataset.value === evaluatorInput.value));
  } else {
    evaluatorTrigger.removeAttribute('aria-activedescendant');
    // Не опускаем слой списка под следующие поля до окончания сворачивания.
    evaluatorField.classList.add('is-closing');
    evaluatorCloseTimer = window.setTimeout(() => evaluatorField.classList.remove('is-closing'), 200);
  }
}

function selectEvaluator(id: string): void {
  if (id && !profileCache.has(id)) return;
  evaluatorInput.value = id;
  evaluatorValueAnimation?.cancel();
  evaluatorValue.replaceChildren(evaluatorIdentity(id));
  for (const option of evaluatorOptions()) {
    option.setAttribute('aria-selected', String(option.dataset.value === id));
  }
  setEvaluatorOpen(false);
  evaluatorTrigger.focus({ preventScroll: true });
  // Та же обратная связь, что у артиста: лавандовая рамка, лёгкий пульс,
  // рисующаяся галочка. Пульсируем только полем, не всем блоком со списком.
  evaluatorPicker.classList.remove('is-picked', 'is-confirming');
  void evaluatorTrigger.offsetWidth;
  evaluatorPicker.classList.add('is-picked', 'is-confirming');
  if (!window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    evaluatorValueAnimation = evaluatorValue.animate([
      { opacity: 0, transform: 'translateY(4px)' },
      { opacity: 1, transform: 'translateY(0)' },
    ], { duration: 240, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
  }
  clearAddErrors();
}

function resetEvaluatorPicker(): void {
  setEvaluatorOpen(false);
  window.clearTimeout(evaluatorCloseTimer);
  evaluatorField.classList.remove('is-closing');
  evaluatorValueAnimation?.cancel();
  evaluatorPicker.classList.remove('is-picked', 'is-confirming');
  evaluatorInput.value = '';
  evaluatorValue.replaceChildren(evaluatorIdentity(''));
  evaluatorList.replaceChildren();
  for (const [index, id] of ['', ...profileCache.keys()].entries()) {
    const option = document.createElement('li');
    option.id = `evaluator-option-${index}`;
    option.className = 'evaluator__option';
    option.setAttribute('role', 'option');
    option.setAttribute('aria-selected', String(id === ''));
    option.dataset.value = id;
    option.style.setProperty('--option-delay', `${index * 28}ms`);
    option.appendChild(evaluatorIdentity(id));
    const check = document.createElement('span');
    check.className = 'evaluator__option-check';
    check.setAttribute('aria-hidden', 'true');
    check.innerHTML = CHECK_SVG;
    option.appendChild(check);
    evaluatorList.appendChild(option);
  }
  highlightEvaluator(0);
}

evaluatorTrigger.addEventListener('click', () => setEvaluatorOpen(!evaluatorOpen));
evaluatorTrigger.addEventListener('keydown', (event) => {
  const { key } = event;
  if (key === 'Escape' && evaluatorOpen) {
    event.preventDefault();
    event.stopPropagation(); // не уходить со страницы добавления
    setEvaluatorOpen(false);
  } else if (key === 'Tab') {
    setEvaluatorOpen(false);
  } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(key)) {
    event.preventDefault();
    const wasOpen = evaluatorOpen;
    if (!wasOpen) setEvaluatorOpen(true);
    const last = evaluatorOptions().length - 1;
    const index = key === 'Home' ? 0 : key === 'End' ? last
      : wasOpen ? evaluatorActiveIndex + (key === 'ArrowDown' ? 1 : -1) : evaluatorActiveIndex;
    highlightEvaluator(index, true);
  } else if (key === 'Enter' || key === ' ') {
    event.preventDefault(); // не отправлять форму и не генерировать второй click
    if (evaluatorOpen) selectEvaluator(evaluatorOptions()[evaluatorActiveIndex]?.dataset.value ?? '');
    else setEvaluatorOpen(true);
  }
});
evaluatorList.addEventListener('pointerdown', (event) => event.preventDefault());
evaluatorList.addEventListener('click', (event) => {
  const option = (event.target as HTMLElement).closest<HTMLElement>('[role="option"]');
  if (option && evaluatorOpen) selectEvaluator(option.dataset.value ?? '');
});
document.addEventListener('pointerdown', (event) => {
  if (evaluatorOpen && !evaluatorPicker.contains(event.target as Node)) setEvaluatorOpen(false);
});
evaluatorPicker.addEventListener('focusout', (event) => {
  if (!evaluatorPicker.contains(event.relatedTarget as Node | null)) setEvaluatorOpen(false);
});

function resetAddForm(): void {
  setEvaluatorOpen(false);
  addForm.reset();
  pendingCover = null;
  coverImg.removeAttribute('src');
  coverPick.classList.remove('has-cover');
  coverFile.value = '';
  coverUrl.value = '';
  clearCoverUrlError();
  window.clearTimeout(coverUrlTimer);
  artistList.hidden = true;
  artistField.classList.remove('is-picked', 'pulse');
  addCoverSearch.reset();
  clearAddErrors();
}

/* Экран добавления один, но работает в двух режимах: альбом или сингл.
   В режиме сингла появляется необязательная привязка к альбому. */
let addKind: ReleaseKind = 'album';

function applyAddMode(kind: ReleaseKind): void {
  addKind = kind;
  evaluatorField.hidden = !isAdmin();
  resetEvaluatorPicker();
  const single = kind === 'single';
  viewAdd.setAttribute('aria-label', single ? 'Добавить сингл' : 'Добавить альбом');
  addTitle.textContent = single ? 'Новый сингл' : 'Новый альбом';
  addSubmitLabel.textContent = single ? 'Добавить сингл' : 'Добавить альбом';
  titleLabel.textContent = single ? 'Название сингла *' : 'Название альбома *';
  artistLabel.textContent = single ? 'Артист или совместка *' : 'Артист *';
  updateArtistFeatNote();
  titleInput.placeholder = single ? 'например, Not Like Us' : 'например, Blonde';
  parentField.hidden = !single;
  parentNote.textContent = single
    ? 'перечислите альбомы через запятую; сингл появится на каждом из них. Без своей обложки используется обложка первого альбома'
    : '';
  coverNote.textContent = single
    ? 'файл или ссылку можно заменить позже, на странице сингла; без своей обложки подставится обложка альбома'
    : 'файл или ссылка — обложку можно будет заменить и позже, на странице альбома';
}

function updateParentList(): void {
  updateAlbumSuggestions(parentInput, parentList, (a) => {
    if (!yearInput.value.trim()) yearInput.value = String(a.year);
    clearAddErrors();
  });
}

parentInput.addEventListener('input', () => {
  updateParentList();
  clearAddErrors();
});
parentInput.addEventListener('focus', updateParentList);
parentInput.addEventListener('blur', () => {
  window.setTimeout(() => {
    if (!parentBox.contains(document.activeElement)) parentList.hidden = true;
  }, 120);
});
document.addEventListener('click', (e) => {
  if (!parentBox.contains(e.target as Node)) parentList.hidden = true;
});

async function openAdd(kind: ReleaseKind = 'album'): Promise<void> {
  resetAddForm();
  applyAddMode(kind);
  await navigateTo(viewAdd, { view: 'add', kind });
}

addBack.addEventListener('click', () => void goBack());

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (albumCoverDialog.open) {
    e.preventDefault();
    closeAlbumCoverEditor();
    return;
  }
  if (singleLinkDialog.open) {
    e.preventDefault();
    closeSingleLinkEditor();
    return;
  }
  if (!confirmModal.hidden) { closeConfirm(false); return; }
  if (document.querySelector('.fin-select.is-open')) { closeAllFinSelects(); return; }
  if (!rankMenuList.hidden) { setRankMenu(false); return; }
  if (activeTrackId) { setActiveTrack(null); return; }
  if (visibleView() && !viewHome.classList.contains('is-visible')) void goBack();
});

async function addAlbum(input: AddInput): Promise<string | null> {
  const evaluatorId = input.evaluatorId ?? null;
  if (evaluatorId && (!isAdmin() || !profileCache.has(evaluatorId))) throw new Error('Назначать оценивающего может только админ');
  const kind = input.kind ?? 'album';
  const parentIds = kind === 'single' ? (input.parentIds ?? []) : [];
  assertCompatibleParents({ evaluatorId }, parentIds);
  const parentId = parentIds[0] ?? null;
  const what = kind === 'single' ? 'сингл' : 'альбом';
  if (CLOUD) {
    const s = getSB();
    let coverUrlFinal = input.coverUrl ?? '';
    if (input.coverDataUrl) coverUrlFinal = await uploadCover(input.coverDataUrl);
    const ins = await s.from('albums').insert({
      artist: input.artist,
      title: input.title,
      year: input.year,
      cover_url: coverUrlFinal || null,
      tracks_locked: false,
      kind,
      parent_album_id: parentId,
      ...(kind === 'single' ? { parent_album_ids: parentIds } : {}),
      created_by: currentUser?.id ?? null,
      ...(evaluatorId ? { evaluator_id: evaluatorId } : {}),
    });
    if (ins.error) {
      if ((ins.error as { code?: string }).code === '23505') {
        throw new Error(`такой ${what} у этого артиста уже есть`);
      }
      if (/column|relation|schema|does not exist/i.test(ins.error.message ?? '')) {
        throw new Error('База не обновлена: выполните migrate.sql в Supabase');
      }
      throw ins.error;
    }
    await refreshData();
    return albums.find(
      (a) => a.kind === kind
        && a.artist.toLowerCase() === input.artist.trim().toLowerCase()
        && a.title.toLowerCase() === input.title.trim().toLowerCase(),
    )?.id ?? null;
  }
  const id = (kind === 'single' ? 's' : 'a') + Date.now().toString(36);
  albums.push({
    id,
    artist: input.artist,
    title: input.title,
    year: input.year,
    cover: input.coverDataUrl ?? input.coverUrl ?? '',
    kind,
    evaluatorId,
    parentId,
    parentIds,
    tracksLocked: false,
    cohesion: null,
    albumType: null,
    geniusId: null,
  });
  saveLocalAlbums();
  return id;
}

addForm.addEventListener('submit', (e) => {
  e.preventDefault();
  if (addPending) return;
  void handleAdd();
});

async function handleAdd(): Promise<void> {
  const artistRaw = artistInput.value.trim();
  const titleRaw = titleInput.value.trim();
  const yearRaw = yearInput.value.trim();
  const single = addKind === 'single';
  const what = single ? 'сингл' : 'альбом';

  let err: string | null = null;
  if (!artistRaw) err = 'Укажите артиста';
  else if (!titleRaw) err = `Укажите название ${single ? 'сингла' : 'альбома'}`;
  else if (!/^\d{4}$/.test(yearRaw)) err = 'Год — четыре цифры, например 2024';
  else {
    const y = Number(yearRaw);
    if (y < 1900 || y > new Date().getFullYear()) err = `Год — от 1900 до ${new Date().getFullYear()}`;
  }
  if (err) {
    showAddError(err);
    shakeEl(addPanel);
    return;
  }

  let parentIds: string[] = [];
  try {
    if (single) parentIds = resolveAlbumTokens(parentInput.value);
  } catch (err) {
    showAddError(messageOf(err));
    shakeEl(addPanel);
    return;
  }

  // Фит/совместка в поле артиста (только для синглов): «Артист & Гость» или
  // «Артист feat. Гость». Основным исполнителем становится первый, гость
  // записывается в название сингла и показывается в блоке артиста.
  let artist = normalizeArtist(artistRaw);
  let titleRecorded = titleRaw;
  if (single) {
    const m = FEAT_RE.exec(artistRaw);
    if (m) {
      const main = artistRaw.slice(0, m.index ?? 0).trim();
      const guest = artistRaw.slice((m.index ?? 0) + m[0].length).replace(/[),.\s]+$/, '').trim();
      if (main && guest) {
        artist = normalizeArtist(main);
        titleRecorded = m[0] === '&' ? `${titleRaw} & ${guest}` : `${titleRaw} (feat. ${guest})`;
      }
    }
  }

  const dup = albums.some(
    (a) => a.kind === addKind
      && a.artist.toLowerCase() === artist.toLowerCase()
      && a.title.toLowerCase() === titleRecorded.toLowerCase(),
  );
  if (dup) {
    showTitleError(`такой ${what} у этого артиста уже есть`);
    shakeEl(addPanel);
    return;
  }

  addPending = true;
  addSubmit.classList.add('is-loading');
  clearAddErrors();
  try {
    const createdId = await addAlbum({
      artist,
      title: titleRecorded,
      year: Number(yearRaw),
      coverDataUrl: pendingCover && pendingCover.startsWith('data:') ? pendingCover : null,
      coverUrl: pendingCover && !pendingCover.startsWith('data:') ? pendingCover : null,
      kind: addKind,
      evaluatorId: isAdmin() ? evaluatorInput.value || null : null,
      parentIds,
    });
    // Сингл с привязкой сразу становится треком альбома (в конец списка).
    const added = createdId ? await attachSingleTracks(createdId, parentIds) : null;
    addPending = false;
    addSubmit.classList.remove('is-loading');
    resetAddForm();
    setHomeMode(addKind, false);
    if (topEntry().view === 'add') viewStack.pop();
    renderAlbums();
    toast(added ?? (single ? 'Сингл добавлен' : 'Альбом добавлен'));
    await swapTo(viewAdd, viewHome, () => { viewHome.scrollTop = 0; });
  } catch (e) {
    addPending = false;
    addSubmit.classList.remove('is-loading');
    showAddError(singleLinkErrorMessage(e));
    shakeEl(addPanel);
  }
}

/* ---------- Эффекты ---------- */
function shakeEl(el: HTMLElement): void {
  el.classList.remove('shake');
  void el.offsetWidth;
  el.classList.add('shake');
}
function shake(): void {
  shakeEl(card);
}

function initTilt(): void {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
  if (reduce || !fine) return;

  let raf = 0;
  let tx = 0, ty = 0, cx = 0, cy = 0;

  card.addEventListener('pointermove', (e) => {
    const rect = card.getBoundingClientRect();
    cx = ((e.clientX - rect.left) / rect.width - 0.5) * 2;
    cy = ((e.clientY - rect.top) / rect.height - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(applyTilt);
  });
  card.addEventListener('pointerleave', () => {
    cx = 0; cy = 0;
    if (!raf) raf = requestAnimationFrame(applyTilt);
  });

  function applyTilt(): void {
    raf = 0;
    tx += (cx - tx) * 0.12;
    ty += (cy - ty) * 0.12;
    card.style.transform =
      `perspective(1100px) rotateX(${(-ty * 3.4).toFixed(2)}deg) rotateY(${(tx * 4.2).toFixed(2)}deg)`;
    if (Math.abs(tx) > 0.001 || Math.abs(ty) > 0.001) {
      raf = requestAnimationFrame(applyTilt);
    }
  }
}

/* ---------- Старт ---------- */
function showDemoHint(): void {
  if (CLOUD) return;
  demoHint.hidden = false;
  demoHint.textContent =
    'демо-режим (без базы): ' + ALLOWED_USERS.map((u) => u.email).join(' · ') + ' — пароль: ' + DEMO_PASSWORD;
}

function showHomeDirect(): void {
  homeTitle.textContent = currentUser?.username ?? 'Гость';
  setAvatarEl(homeAvatar, currentUser);
  viewLogin.classList.remove('is-visible');
  viewLogin.style.display = 'none';
  viewHome.style.display = '';
  viewHome.classList.add('is-visible');
  renderAlbums();
}

async function init(): Promise<void> {
  homeMode = loadHomeMode();
  initTilt();
  showDemoHint();

  card.classList.add('enter');
  window.setTimeout(() => card.classList.add('animate-in'), 140);

  if (CLOUD) {
    try {
      const { data } = await getSB().auth.getSession();
      if (data.session) {
        currentUser = await ensureProfile(data.session.user);
        await refreshData();
        subscribeRealtime();
        showHomeDirect();
        return;
      }
    } catch { /* остаёмся на экране входа */ }
  }
}

/* шейк-анимация (добавляется динамически) */
const style = document.createElement('style');
style.textContent = `
  .card.shake, .add__panel.shake { animation: shake 0.45s cubic-bezier(0.36, 0.07, 0.19, 0.97); }
  @keyframes shake {
    10%, 90% { transform: translateX(-1px); }
    20%, 80% { transform: translateX(2px); }
    30%, 50%, 70% { transform: translateX(-4px); }
    40%, 60% { transform: translateX(4px); }
  }
`;
document.head.appendChild(style);

/* производительность: пока пользователь прокручивает любой экран,
   декоративный фон приостанавливает «дыхание» (класс .is-scrolling),
   а через 160 мс после остановки продолжает с той же фазы.
   Слушатель пассивный и в фазе захвата: события scroll не всплывают,
   но проходят через window при захвате — ловим прокрутку всех экранов. */
(() => {
  const bgLayer = document.querySelector<HTMLElement>('.bg');
  if (!bgLayer) return;
  let timer = 0;
  window.addEventListener('scroll', () => {
    bgLayer.classList.add('is-scrolling');
    window.clearTimeout(timer);
    timer = window.setTimeout(() => bgLayer.classList.remove('is-scrolling'), 160);
  }, { passive: true, capture: true });
})();

void init();
