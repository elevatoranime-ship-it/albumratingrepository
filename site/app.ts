/* ==========================================================================
   Пространство · альбомы и оценки
   Оценки ставятся НА ТРЕКИ; балл альбома = среднее арифметическое оценок
   его треков. Данные: Supabase (облако) или localStorage (демо).
   ========================================================================== */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';

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
const CLOUD = Boolean(cfg && cfg.supabaseUrl && cfg.supabaseAnonKey);
const ALLOWED_USERS: AllowedUser[] =
  cfg && cfg.allowedUsers && cfg.allowedUsers.length ? cfg.allowedUsers : DEFAULT_USERS;
const DEMO_PASSWORD = cfg?.demoPassword ?? 'demo';

/* ---------- Supabase ---------- */
let sb: SupabaseClient | null = null;
function getSB(): SupabaseClient {
  if (!sb) sb = createClient(cfg!.supabaseUrl, cfg!.supabaseAnonKey);
  return sb;
}

/* ---------- Типы ---------- */
interface ProfileInfo { id: string; email: string; username: string; initials: string; avatarUrl: string | null; }
interface UiAlbum {
  id: string; artist: string; title: string; year: number; cover: string;
  tracksLocked: boolean;
  cohesion: number | null;      // целостность/концептуальность: 1..5, финально
  albumType: string | null;     // 'album' | 'ep' | 'compilation', финально
}
interface UiTrack { id: string; albumId: string; title: string; position: number; locked: boolean; featArtist: string | null; }
interface TrackRating { score: number; confirmed: boolean; }
interface AddInput {
  artist: string; title: string; year: number;
  coverDataUrl: string | null;
  coverUrl: string | null;
}

/* ---------- Демо-сид (локальный режим) ---------- */
const SEED_ALBUMS: UiAlbum[] = [
  { id: 'music', title: 'MUSIC', artist: 'Playboi Carti', year: 2025, cover: 'covers/music.jpg', tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'afterlyfe', title: 'AftërLyfe', artist: 'Yeat', year: 2023, cover: 'covers/afterlyfe.jpg', tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'chromakopia', title: 'CHROMAKOPIA', artist: 'Tyler, The Creator', year: 2024, cover: 'covers/chromakopia.jpg', tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'gnx', title: 'GNX', artist: 'Kendrick Lamar', year: 2024, cover: 'covers/gnx.jpg', tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'hurry-up-tomorrow', title: 'Hurry Up Tomorrow', artist: 'The Weeknd', year: 2025, cover: 'covers/hurry-up-tomorrow.jpg', tracksLocked: false, cohesion: null, albumType: 'album' },
  { id: 'blonde', title: 'Blonde', artist: 'Frank Ocean', year: 2016, cover: 'covers/blonde.jpg', tracksLocked: false, cohesion: null, albumType: 'album' },
];

/* ---------- Состояние ---------- */
let currentUser: ProfileInfo | null = null;
let albums: UiAlbum[] = [];
let tracks: UiTrack[] = [];
let trackRatings: Record<string, Record<string, TrackRating>> = {}; // trackId -> profileId -> {score, confirmed}
let currentAlbumId: string | null = null;
let currentArtistName: string | null = null;
/* стек навигации: история переходов, верхний элемент — текущий экран */
type ViewEntry = { view: 'home' | 'album' | 'artist' | 'profile' | 'rank'; albumId?: string };
const viewStack: ViewEntry[] = [{ view: 'home' }];
const profileCache = new Map<string, { username: string; initials: string; avatarUrl: string | null }>(); // profileId -> подпись + аватар

/* ---------- Локальное хранилище (демо) ---------- */
const LS_KEY = 'albums_local_v1';
const LS_TRACKS = 'tracks_local_v1';
const LS_RATINGS = 'track_ratings_local_v1';
const LS_META = 'profile_meta_local_v1'; // { email: { username, avatarUrl } } — правки ника/аватара в демо

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

function loadLocalAlbums(): UiAlbum[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as UiAlbum[];
      if (Array.isArray(parsed)) return parsed.map((a) => ({
        ...a,
        tracksLocked: Boolean(a.tracksLocked),
        cohesion: a.cohesion ?? null,
        albumType: a.albumType ?? null,
      }));
    }
  } catch { /* ignore */ }
  return SEED_ALBUMS.map((a) => ({ ...a }));
}

function loadLocalTracks(): UiTrack[] {
  try {
    const raw = localStorage.getItem(LS_TRACKS);
    if (raw) {
      const parsed = JSON.parse(raw) as UiTrack[];
      if (Array.isArray(parsed)) {
        return parsed.map((t) => ({ ...t, locked: Boolean(t.locked), featArtist: t.featArtist ?? null }));
      }
    }
  } catch { /* ignore */ }
  return [];
}

function loadLocalRatings(): Record<string, Record<string, TrackRating>> {
  try {
    const raw = localStorage.getItem(LS_RATINGS);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Record<string, number | TrackRating>>;
      const out: Record<string, Record<string, TrackRating>> = {};
      for (const [tid, map] of Object.entries(parsed)) {
        out[tid] = {};
        for (const [pid, v] of Object.entries(map)) {
          out[tid][pid] = typeof v === 'number'
            ? { score: v, confirmed: false }
            : { score: v.score, confirmed: Boolean(v.confirmed) };
        }
      }
      return out;
    }
  } catch { /* ignore */ }
  return {};
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

/* ---------- Данные ---------- */
async function refreshData(): Promise<void> {
  if (CLOUD) {
    const s = getSB();
    const [pa, aa, ta, ra] = await Promise.all([
      s.from('profiles').select('id, username, initials, avatar_url'),
      s.from('albums').select('*').order('created_at', { ascending: true }),
      s.from('tracks').select('*'),
      s.from('ratings').select('*'),
    ]);
    if (pa.error) throw pa.error;
    if (aa.error) throw aa.error;
    if (ta.error) throw ta.error;
    if (ra.error) throw ra.error;

    profileCache.clear();
    for (const p of (pa.data ?? []) as Array<{ id: string; username: string; initials: string; avatar_url: string | null }>) {
      profileCache.set(p.id, { username: p.username, initials: p.initials, avatarUrl: p.avatar_url ?? null });
    }
    if (currentUser) {
      const me = profileCache.get(currentUser.id);
      if (me) currentUser.username = me.username, currentUser.avatarUrl = me.avatarUrl;
    }

    albums = ((aa.data ?? []) as Array<{ id: string; artist: string; title: string; year: number; cover_url: string | null; tracks_locked: boolean | null; cohesion: number | null; album_type: string | null }>)
      .map((x) => ({ id: x.id, artist: x.artist, title: x.title, year: x.year, cover: x.cover_url ?? '', tracksLocked: Boolean(x.tracks_locked), cohesion: x.cohesion ?? null, albumType: x.album_type ?? null }));

    tracks = ((ta.data ?? []) as Array<{ id: string; album_id: string; title: string; position: number; locked: boolean | null; feat_artist: string | null }>)
      .map((t) => ({ id: t.id, albumId: t.album_id, title: t.title, position: t.position, locked: Boolean(t.locked), featArtist: t.feat_artist ?? null }));

    trackRatings = {};
    for (const r of (ra.data ?? []) as Array<{ track_id: string; profile_id: string; score: number; confirmed: boolean | null }>) {
      (trackRatings[r.track_id] ??= {})[r.profile_id] = { score: r.score, confirmed: Boolean(r.confirmed) };
    }
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
    trackRatings = loadLocalRatings();
  }
}

let realtimeOn = false;
function subscribeRealtime(): void {
  if (!CLOUD || realtimeOn) return;
  realtimeOn = true;
  getSB()
    .channel('db-changes')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'albums' }, () => void safeRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tracks' }, () => void safeTracksRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'ratings' }, () => void safeRatingsRefresh())
    .on('postgres_changes', { event: '*', schema: 'public', table: 'profiles' }, () => void safeRefresh())
    .subscribe();
}

async function safeRefresh(): Promise<void> {
  try {
    await refreshData();
    if (viewHome.classList.contains('is-visible')) renderAlbums();
    if (currentAlbumId && viewAlbum.classList.contains('is-visible')) {
      const al = albums.find((a) => a.id === currentAlbumId);
      if (al) { renderAlbumPage(al); }
    }
    if (currentArtistName && viewArtist.classList.contains('is-visible')) renderArtistPage();
    if (viewRank.classList.contains('is-visible')) renderArtistRank();
  } catch { /* ignore */ }
}

async function safeTracksRefresh(): Promise<void> {
  if (!currentAlbumId || !viewAlbum.classList.contains('is-visible')) {
    try {
      await refreshData();
      if (viewHome.classList.contains('is-visible')) renderAlbums();
      if (currentArtistName && viewArtist.classList.contains('is-visible')) renderArtistPage();
      if (viewRank.classList.contains('is-visible')) renderArtistRank();
    } catch { /* ignore */ }
    return;
  }
  try {
    await refreshData();
    renderTracks();
    updateRatingDisplays();
    if (currentArtistName && viewArtist.classList.contains('is-visible')) renderArtistPage();
    if (viewRank.classList.contains('is-visible')) renderArtistRank();
  } catch { /* ignore */ }
}

async function safeRatingsRefresh(): Promise<void> {
  if (ratingEditing) return; // не мешаем активному слайдеру
  const albumOpen = Boolean(currentAlbumId && viewAlbum.classList.contains('is-visible'));
  const artistOpen = Boolean(currentArtistName && viewArtist.classList.contains('is-visible'));
  const rankOpen = viewRank.classList.contains('is-visible');
  if (!albumOpen && !artistOpen && !rankOpen) return;
  try {
    if (CLOUD) {
      const { data, error } = await getSB().from('ratings').select('*');
      if (error) return;
      trackRatings = {};
      for (const r of (data ?? []) as Array<{ track_id: string; profile_id: string; score: number; confirmed: boolean | null }>) {
        (trackRatings[r.track_id] ??= {})[r.profile_id] = { score: r.score, confirmed: Boolean(r.confirmed) };
      }
    }
    if (albumOpen) {
      renderTracks();
      updateRatingDisplays();
    }
    if (artistOpen) renderArtistPage();
    if (rankOpen) renderArtistRank();
  } catch { /* ignore */ }
}

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

function trackScoreOf(trackId: string): number | null {
  const r = trackRatings[trackId];
  if (!r) return null;
  const vals = Object.values(r).map((x) => x.score);
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
}

function albumScoreOf(albumId: string): number | null {
  const vals: number[] = [];
  for (const t of tracks) {
    if (t.albumId !== albumId) continue;
    const r = trackRatings[t.id];
    if (r) for (const v of Object.values(r)) vals.push(v.score);
  }
  return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
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

/* итог подтверждён, когда оба участника подтвердили оценку каждого трека */
function albumAllConfirmed(albumId: string): boolean {
  if (profileCache.size < 2) return false;
  const list = tracks.filter((t) => t.albumId === albumId);
  if (!list.length) return false;
  for (const t of list) {
    const r = trackRatings[t.id];
    if (!r) return false;
    for (const pid of profileCache.keys()) {
      const e = r[pid];
      if (!e || !e.confirmed) return false;
    }
  }
  return true;
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

function coverSrc(a: UiAlbum): string {
  if (a.cover) return a.cover;
  const initial = (a.title.trim().charAt(0) || '?').toUpperCase();
  const svg =
    "<svg xmlns='http://www.w3.org/2000/svg' width='600' height='600'>" +
    "<rect width='600' height='600' fill='#15151a'/>" +
    "<circle cx='300' cy='300' r='210' fill='none' stroke='rgba(183,168,239,0.16)' stroke-width='1.5'/>" +
    "<text x='300' y='345' font-family='Georgia, serif' font-size='210' fill='rgba(243,241,236,0.8)' text-anchor='middle'>" +
    esc(initial) +
    '</text></svg>';
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
}

/* --- фиты и профили артистов --- */
const FEAT_RE = /(\bfeat\.|\bft\.|&)/i;

function featNameOf(title: string): string | null {
  const m = FEAT_RE.exec(title);
  if (!m) return null;
  const after = title.slice((m.index ?? 0) + m[0].length).trim();
  return after || null;
}

/* все артисты: основные из альбомов + фиты из треков (без дублей, каноничный регистр) */
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
  return albums.filter((a) => a.artist.toLowerCase() === k);
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

/* средний балл артиста: личные альбомы + фиты */
function artistScoreOf(name: string): number | null {
  const vals: number[] = [];
  for (const a of artistOwnAlbums(name)) {
    const s = albumScoreOf(a.id);
    if (s !== null) vals.push(s);
  }
  for (const f of artistFeatureAlbums(name)) {
    if (f.score !== null) vals.push(f.score);
  }
  return vals.length ? round2(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
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
function tweenText(el: HTMLElement, to: number | null): void {
  if (to === null) {
    el.textContent = '—';
    delete el.dataset.val;
    return;
  }
  const cur = parseFloat(el.dataset.val ?? el.textContent ?? '');
  const from = isNaN(cur) ? to : cur;
  if (Math.abs(from - to) < 0.005) {
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
    if (p < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
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
const artistFeatSection = q<HTMLElement>('#artist-feat-section');

/* рейтинг артистов */
const rankBack = q<HTMLButtonElement>('#rank-back');
const rankList = q<HTMLOListElement>('#artist-rank-list');
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
const artistBox = q<HTMLDivElement>('#artist-box');
const artistField = q<HTMLDivElement>('#artist-field');
const artistInput = q<HTMLInputElement>('#artist-input');
const artistList = q<HTMLUListElement>('#artist-list');
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
const addError = q<HTMLParagraphElement>('#add-error');

/* ---------- Переходы между экранами ---------- */
async function swapTo(from: HTMLElement, to: HTMLElement, after?: () => void): Promise<void> {
  from.classList.add('is-leaving');
  await sleep(560);
  from.classList.remove('is-visible', 'is-leaving');
  from.style.display = 'none';
  to.style.display = '';
  to.classList.remove('is-visible');
  requestAnimationFrame(() => {
    to.classList.add('is-visible');
    if (after) after();
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
  await swapTo(viewLogin, viewHome, () => { viewHome.scrollTop = 0; });
  passwordInput.value = '';
  password2Input.value = '';
  renderAlbums();
  toast(`Добро пожаловать, ${currentUser?.username ?? ''}!`);
}

logoutBtn.addEventListener('click', () => {
  void (async () => {
    if (CLOUD) await getSB().auth.signOut();
    currentUser = null;
    currentAlbumId = null;
    currentArtistName = null;
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

/* ---------- Карточки альбомов ---------- */
function renderAlbums(): void {
  const grid = q<HTMLDivElement>('#albums');
  grid.innerHTML = '';

  albums.forEach((a, i) => {
    const el = document.createElement('article');
    el.className = 'album reveal';
    el.style.setProperty('--d', `${(0.2 + i * 0.07).toFixed(2)}s`);

    const avg = albumScoreOf(a.id);
    const avgStr = avg === null ? '—' : fmt(avg);
    const n = trackCountOf(a.id);

    el.innerHTML = `
      <div class="album__cover">
        <img src="${esc(coverSrc(a))}" alt="${esc(a.artist)} — ${esc(a.title)}" loading="lazy">
        <span class="album__year">${a.year}</span>
        ${a.albumType ? `<span class="album__type">${esc(typeLabelOf(a.albumType))}</span>` : ''}
      </div>
      <div class="album__body">
        <h3 class="album__title">${esc(a.title)}</h3>
        <p class="album__artist"><a class="album__artist-link" data-artist="${esc(a.artist)}">${esc(a.artist)}</a></p>
        <div class="album__rating">
          <div class="album__avg">
            <span class="album__avg-num">${avgStr}</span>
            <span class="album__avg-of">/10</span>
          </div>
          <div class="album__votes"><span class="album__count">${n} ${tracksPlural(n)}</span></div>
        </div>
      </div>`;

    el.addEventListener('click', (ev) => {
      if ((ev.target as HTMLElement).closest('.album__artist-link')) return; // клик по артисту
      void openAlbum(a.id);
    });
    el.addEventListener('animationend', () => {
      if (el.classList.contains('reveal')) {
        el.classList.remove('reveal');
        el.style.animation = 'none';
      }
    });

    grid.appendChild(el);
  });

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'album album--add reveal';
  add.style.setProperty('--d', `${(0.2 + albums.length * 0.07).toFixed(2)}s`);
  add.innerHTML = '<span class="album__plus">+</span><span class="album__addtext">добавить альбом</span>';
  add.addEventListener('click', () => openAdd());
  add.addEventListener('animationend', () => {
    if (add.classList.contains('reveal')) {
      add.classList.remove('reveal');
      add.style.animation = 'none';
    }
  });
  grid.appendChild(add);

  const rated = albums.filter((a) => albumScoreOf(a.id) !== null);
  const overall = rated.length
    ? rated.reduce((s, a) => s + (albumScoreOf(a.id) as number), 0) / rated.length
    : null;
  homeMeta.textContent = `${albums.length} ${plural(albums.length)}${
    overall !== null ? ' · средняя оценка ' + fmt(overall) : ''
  }`;
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
  avTitle.textContent = al.title;
  avArtist.innerHTML = `<a class="av__artist-link" data-artist="${esc(al.artist)}">${esc(al.artist)}</a>`;
  avYear.textContent = String(al.year);
  renderAlbumCover(al);
  const score = albumScoreOf(al.id);
  avAvg.textContent = score === null ? '—' : fmt(score);
  delete avAvg.dataset.val;
  renderTracks();
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
}

function resetAlbumCoverDraft(): number {
  window.clearTimeout(albumCoverUrlTimer);
  albumCoverRequest += 1; // поздние ответы от предыдущего файла/URL больше не применяются
  albumCoverDraft = null;
  albumCoverPreparing = false;
  showAlbumCoverError();
  const al = albums.find((a) => a.id === editingCoverAlbumId);
  if (al) albumCoverPreview.src = coverSrc(al);
  updateAlbumCoverControls();
  return albumCoverRequest;
}

function openAlbumCoverEditor(): void {
  const al = currentAlbum();
  if (!al || !currentUser || albumCoverDialog.open) return;
  editingCoverAlbumId = al.id;
  albumCoverForm.reset();
  albumCoverTitle.textContent = al.cover ? 'Изменить обложку' : 'Добавить обложку';
  albumCoverName.textContent = `${al.artist} — ${al.title}`;
  resetAlbumCoverDraft();
  albumCoverDialog.showModal();
  // Фиксируем начальные стили после showModal(), чтобы окно и фон плавно появились.
  void albumCoverDialog.offsetWidth;
  albumCoverDialog.classList.add('is-open');
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

async function saveAlbumCover(albumId: string, source: string): Promise<void> {
  if (!currentUser) throw new Error('Войдите в аккаунт заново');
  if (!albums.some((a) => a.id === albumId)) throw new Error('Альбом больше не доступен');
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
  const al = currentAlbum();
  if (al?.id === albumId) renderAlbumCover(al);
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
    ? finSelectHTML('cohesion', COHESION_OPTIONS.map((o, i) => ({ value: String(i + 1), label: o })))
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
  if (!al) return;
  if (CLOUD) {
    const { error } = await getSB().from('albums').update({ cohesion: v }).eq('id', al.id);
    if (error) throw error;
  } else {
    saveLocalAlbums();
  }
  al.cohesion = v;
  renderFinalize('cohesion');
}

async function saveAlbumType(v: string): Promise<void> {
  const al = currentAlbum();
  if (!al) return;
  if (CLOUD) {
    const { error } = await getSB().from('albums').update({ album_type: v }).eq('id', al.id);
    if (error) throw error;
  } else {
    saveLocalAlbums();
  }
  al.albumType = v;
  renderFinalize('type');
}

/* --- модальное подтверждение --- */
let confirmResolve: ((ok: boolean) => void) | null = null;

function openConfirm(title: string, text: string, danger = false): Promise<boolean> {
  return new Promise((resolve) => {
    confirmTitle.textContent = title;
    confirmText.innerHTML = text;
    confirmOk.classList.toggle('is-danger', danger);
    confirmOk.textContent = danger ? 'удалить' : 'подтвердить';
    confirmModal.hidden = false;
    requestAnimationFrame(() => confirmModal.classList.add('is-open'));
    confirmResolve = resolve;
  });
}

function closeConfirm(ok: boolean): void {
  confirmModal.classList.remove('is-open');
  const res = confirmResolve;
  confirmResolve = null;
  window.setTimeout(() => { confirmModal.hidden = true; }, 320);
  res?.(ok);
}

confirmOk.addEventListener('click', () => closeConfirm(true));
confirmCancel.addEventListener('click', () => closeConfirm(false));
confirmModal.addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-confirm-close]')) closeConfirm(false);
});

/* --- оценка трека: слайдер + число, реал-тайм с дебаунсом --- */
let ratingEditing = false;
const saveTimers = new Map<string, number>();

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
  if (!currentUser) return;
  const prev = trackRatings[trackId]?.[currentUser.id];
  (trackRatings[trackId] ??= {})[currentUser.id] = { score: v, confirmed: prev?.confirmed === true };
  if (!CLOUD) saveLocalRatings();
  setTrackSave(trackId, 'save');
  updateRatingDisplays(trackId);
  scheduleTrackSave(trackId);
}

function clearTrackRating(trackId: string): void {
  if (!currentUser) return;
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

function scheduleTrackSave(trackId: string): void {
  const existing = saveTimers.get(trackId);
  if (existing) window.clearTimeout(existing);
  const t = window.setTimeout(() => void persistTrackRating(trackId), 500);
  saveTimers.set(trackId, t);
}

async function persistTrackRating(trackId: string): Promise<void> {
  if (!currentUser) return;
  const entry = trackRatings[trackId]?.[currentUser.id];
  setTrackSave(trackId, 'save');
  try {
    if (CLOUD) {
      if (entry) {
        await getSB().from('ratings').upsert(
          { track_id: trackId, profile_id: currentUser.id, score: entry.score },
          { onConflict: 'track_id,profile_id' },
        );
      } else {
        await getSB().from('ratings').delete().eq('track_id', trackId).eq('profile_id', currentUser.id);
      }
    } else {
      saveLocalRatings();
    }
    setTrackSave(trackId, 'done');
  } catch (err) {
    setTrackSave(trackId, 'err');
    toast(messageOf(err));
  }
}

/* подтвердить/снять подтверждение своей оценки */
async function toggleRatingConfirm(trackId: string): Promise<void> {
  if (!currentUser) return;
  const entry = trackRatings[trackId]?.[currentUser.id];
  if (!entry) return;
  const next = !entry.confirmed;
  entry.confirmed = next;
  if (!CLOUD) saveLocalRatings();

  const li = trackList.querySelector<HTMLLIElement>(`[data-id="${trackId}"]`);
  if (li) applyRatingLockState(li, next);
  renderConfirmState();

  try {
    if (CLOUD) {
      await getSB().from('ratings').upsert(
        { track_id: trackId, profile_id: currentUser.id, score: entry.score, confirmed: next },
        { onConflict: 'track_id,profile_id' },
      );
    }
    toast(next ? 'Оценка подтверждена' : 'Оценку можно менять');
  } catch (err) {
    entry.confirmed = !next;
    if (!CLOUD) saveLocalRatings();
    if (li) applyRatingLockState(li, entry.confirmed);
    renderConfirmState();
    toast(messageOf(err));
  }
}

function applyRatingLockState(li: HTMLLIElement, confirmed: boolean): void {
  li.classList.toggle('is-rated-locked', confirmed);
  const slider = li.querySelector<HTMLInputElement>('.track__slider');
  const num = li.querySelector<HTMLInputElement>('.track__numinput');
  const btn = li.querySelector<HTMLButtonElement>('.track__confirm-btn');
  if (slider) slider.disabled = confirmed;
  if (num) num.disabled = confirmed;
  if (btn) {
    btn.innerHTML = confirmed ? PENCIL_SVG : CHECK_SVG;
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

function renderTracks(enterId?: string): void {
  const al = currentAlbum();
  const locked = al?.tracksLocked ?? false;
  const list = tracks.filter((t) => t.albumId === currentAlbumId).sort((a, b) => a.position - b.position);
  const myId = currentUser?.id ?? '';

  trackList.innerHTML = '';

  list.forEach((t, i) => {
    const mine = trackRatings[t.id]?.[myId];
    const mineScore = typeof mine?.score === 'number' ? mine.score : undefined;
    const mineConfirmed = mine?.confirmed === true;
    const tavg = trackScoreOf(t.id);
    const tavgStr = tavg === null ? '—' : fmt(tavg);
    const mineStr = typeof mineScore === 'number' ? fmt(mineScore) : '';
    const peer = peerRatingOf(t.id);
    const canRename = !locked && !t.locked; // фиксация названия (или количества) запрещает переименование
    const canOrder = !locked;               // только фиксация количества запрещает порядок/удаление

    const li = document.createElement('li');
    li.className = 'track';
    if (t.locked) li.classList.add('is-locked');
    if (locked) li.classList.add('is-frozen');
    if (mineConfirmed) li.classList.add('is-rated-locked');
    li.dataset.id = t.id;

    const actions = [
      canRename ? `<button class="track__btn" data-act="rename" type="button" aria-label="Переименовать">${PENCIL_SVG}</button>` : '',
      canOrder ? `<button class="track__btn" data-act="up" type="button" aria-label="Выше"${i === 0 ? ' disabled' : ''}>${UP_SVG}</button>` : '',
      canOrder ? `<button class="track__btn" data-act="down" type="button" aria-label="Ниже"${i === list.length - 1 ? ' disabled' : ''}>${DOWN_SVG}</button>` : '',
      isAdmin() ? `<button class="track__btn" data-act="lock" type="button" aria-label="${t.locked ? 'Снять фиксацию названия' : 'Зафиксировать название'}" title="${t.locked ? 'Снять фиксацию названия' : 'Зафиксировать название'}">${t.locked ? UNLOCK_SVG : LOCK_SVG}</button>` : '',
      canOrder ? `<button class="track__btn track__btn--del" data-act="del" type="button" aria-label="Удалить">${DEL_SVG}</button>` : '',
    ].join('');

    const peerBadge = peer && peer.confirmed
      ? `<span class="track__peer" title="оценка ${esc(peer.username)} · подтверждена">
           ${avatarMarkup(peer, 'track__peer-who')}
           <span class="track__peer-val">${fmt(peer.score)}</span>
         </span>`
      : '';

    li.innerHTML = `
      <div class="track__row1">
        <span class="track__handle"${canOrder ? ' draggable="true"' : ''} aria-hidden="true">${GRIP_SVG}</span>
        <span class="track__num">${i + 1}</span>
        <span class="track__title">${trackTitleHTML(t)}</span>
        ${peerBadge}
        ${t.locked ? `<span class="track__lock" title="название зафиксировано">${LOCK_SVG}</span>` : ''}
        <span class="track__avg" data-tid="${t.id}" title="средняя по треку">${tavgStr}</span>
        <span class="track__actions">${actions}</span>
      </div>
      <div class="track__row2">
        <span class="track__rate-label">моя оценка</span>
        <input class="track__slider" type="range" min="0" max="10" step="0.01" value="${typeof mineScore === 'number' ? mineScore : 5}" aria-label="Моя оценка"${mineConfirmed ? ' disabled' : ''} />
        <input class="track__numinput" type="number" min="0" max="10" step="0.01" inputmode="decimal" placeholder="—" value="${mineStr}"${mineConfirmed ? ' disabled' : ''} />
        <button class="track__confirm-btn" type="button"${typeof mineScore === 'number' ? '' : ' disabled'} aria-label="${mineConfirmed ? 'Изменить оценку' : 'Подтвердить оценку'}" title="${mineConfirmed ? 'Изменить оценку' : 'Подтвердить оценку'}">${mineConfirmed ? PENCIL_SVG : CHECK_SVG}</button>
        <span class="track__save" aria-live="polite"></span>
      </div>`;

    trackList.appendChild(li);
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
}

/* события ввода оценки (делегирование) */
trackList.addEventListener('input', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('track__slider')) {
    ratingEditing = true;
    const li = target.closest<HTMLLIElement>('.track');
    if (!li || !li.dataset.id) return;
    const v = round2(parseFloat((target as HTMLInputElement).value));
    const num = li.querySelector<HTMLInputElement>('.track__numinput');
    if (num) num.value = fmt(v);
    setTrackRating(li.dataset.id, v);
    const cbtn = li.querySelector<HTMLButtonElement>('.track__confirm-btn');
    if (cbtn) cbtn.disabled = false;
  } else if (target.classList.contains('track__numinput')) {
    ratingEditing = true;
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
    const cbtn = li.querySelector<HTMLButtonElement>('.track__confirm-btn');
    if (cbtn) cbtn.disabled = false;
  }
});

trackList.addEventListener('pointerdown', (e) => {
  const target = e.target as HTMLElement;
  if (target.classList.contains('track__slider') || target.classList.contains('track__numinput')) {
    ratingEditing = true;
  }
});

document.addEventListener('pointerup', () => {
  window.setTimeout(() => { ratingEditing = false; }, 200);
});

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
      tracks.push({ id: newId, albumId: currentAlbumId, title, position, locked: false, featArtist });
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

/* клики по кнопкам треков */
trackList.addEventListener('click', (e) => {
  const featLink = (e.target as HTMLElement).closest<HTMLAnchorElement>('.track__feat');
  if (featLink) {
    e.preventDefault();
    const name = featLink.dataset.artist;
    if (name) void openArtist(name);
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
  if (act === 'up') void moveTrack(idx, idx - 1);
  else if (act === 'down') void moveTrack(idx, idx + 1);
  else if (act === 'del') void deleteTrack(id);
  else if (act === 'lock') void toggleTrackLock(id);
  else if (act === 'rename') startRename(li);
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
  for (const v of [viewHome, viewAlbum, viewArtist, viewProfile, viewRank]) {
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
  const prev = topEntry();
  const from = visibleView() ?? viewHome;
  switch (prev.view) {
    case 'album': {
      currentAlbumId = prev.albumId ?? null;
      const al = albums.find((a) => a.id === prev.albumId);
      if (al) renderAlbumPage(al);
      await swapTo(from, viewAlbum, () => { viewAlbum.scrollTop = 0; });
      break;
    }
    case 'artist': {
      currentAlbumId = null;
      if (currentArtistName) renderArtistPage();
      await swapTo(from, viewArtist, () => { viewArtist.scrollTop = 0; });
      break;
    }
    case 'profile': {
      currentAlbumId = null;
      currentArtistName = null;
      renderProfilePage();
      await swapTo(from, viewProfile, () => { viewProfile.scrollTop = 0; });
      break;
    }
    case 'rank': {
      currentAlbumId = null;
      currentArtistName = null;
      renderArtistRank();
      await swapTo(from, viewRank, () => { viewRank.scrollTop = 0; });
      break;
    }
    default: {
      currentAlbumId = null;
      currentArtistName = null;
      renderAlbums();
      await swapTo(from, viewHome, () => { viewHome.scrollTop = 0; });
    }
  }
}

/* --- открытие/закрытие страницы альбома --- */
async function openAlbum(id: string): Promise<void> {
  const al = albums.find((a) => a.id === id);
  if (!al) return;
  currentAlbumId = id;
  resetTrackForm();
  renderAlbumPage(al);
  await navigateTo(viewAlbum, { view: 'album', albumId: id });
}

albumBack.addEventListener('click', () => void goBack());

/* --- профиль артиста --- */
function makeAlbumCard(a: UiAlbum, featScore: number | null = null): HTMLElement {
  const el = document.createElement('article');
  el.className = 'album';
  const avg = albumScoreOf(a.id);
  const avgStr = avg === null ? '—' : fmt(avg);
  const n = trackCountOf(a.id);
  el.innerHTML = `
    <div class="album__cover">
      <img src="${esc(coverSrc(a))}" alt="${esc(a.artist)} — ${esc(a.title)}" loading="lazy">
      <span class="album__year">${a.year}</span>
      ${a.albumType ? `<span class="album__type">${esc(typeLabelOf(a.albumType))}</span>` : ''}
      ${featScore !== null ? `<span class="album__featbadge">фит ${fmt(featScore)}</span>` : ''}
    </div>
    <div class="album__body">
      <h3 class="album__title">${esc(a.title)}</h3>
      <p class="album__artist">${esc(a.artist)}</p>
      <div class="album__rating">
        <div class="album__avg">
          <span class="album__avg-num">${avgStr}</span>
          <span class="album__avg-of">/10</span>
        </div>
        <div class="album__votes"><span class="album__count">${n} ${tracksPlural(n)}</span></div>
      </div>
    </div>`;
  el.addEventListener('click', () => void openAlbum(a.id));
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

  const feats = artistFeatureAlbums(name);
  artistFeatSection.hidden = feats.length === 0;
  artistFeat.innerHTML = '';
  for (const f of feats) artistFeat.appendChild(makeAlbumCard(f.album, f.score));
}

/* --- рейтинг артистов --- */
interface ArtistRank { name: string; score: number | null; ownCount: number; featCount: number; cover: string; }

function artistRanks(): ArtistRank[] {
  return allArtistNames().map((name) => {
    const own = artistOwnAlbums(name);
    const feats = artistFeatureAlbums(name);
    const cands: Array<{ album: UiAlbum; score: number | null }> = [];
    for (const a of own) cands.push({ album: a, score: albumScoreOf(a.id) });
    for (const f of feats) cands.push({ album: f.album, score: f.score });
    cands.sort((x, y) => (y.score ?? -1) - (x.score ?? -1));
    const best = cands[0];
    return {
      name,
      score: artistScoreOf(name),
      ownCount: own.length,
      featCount: feats.length,
      cover: best ? coverSrc(best.album) : '',
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

artistsBtn.addEventListener('click', () => void openArtists());
rankBack.addEventListener('click', () => void goBack());

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
      albums = albums.filter((a) => a.id !== al.id);
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
async function crumbleCover(): Promise<void> {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const cover = document.querySelector<HTMLElement>('.av__cover');
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
      (a) => a.artist.toLowerCase() === artist.toLowerCase() && a.title.toLowerCase() === title.toLowerCase(),
    );
    if (dup) showTitleError('такой альбом у этого артиста уже есть');
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
  titleInput.focus();
}

function markArtistPicked(): void {
  artistField.classList.remove('pulse', 'is-picked');
  void artistField.offsetWidth;
  artistField.classList.add('is-picked', 'pulse');
}

artistInput.addEventListener('input', () => {
  artistField.classList.remove('is-picked');
  updateArtistList();
  clearAddErrors();
  refreshDupHint();
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
});

function resetAddForm(): void {
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
  clearAddErrors();
}

function openAdd(): void {
  resetAddForm();
  void swapTo(viewHome, viewAdd, () => { viewAdd.scrollTop = 0; });
}

function closeAdd(): void {
  void swapTo(viewAdd, viewHome, () => { viewHome.scrollTop = 0; });
}

addBack.addEventListener('click', closeAdd);

document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  if (albumCoverDialog.open) {
    e.preventDefault();
    closeAlbumCoverEditor();
    return;
  }
  if (!confirmModal.hidden) { closeConfirm(false); return; }
  if (document.querySelector('.fin-select.is-open')) { closeAllFinSelects(); return; }
  if (viewAdd.classList.contains('is-visible')) closeAdd();
  else if (visibleView() && !viewHome.classList.contains('is-visible')) void goBack();
});

async function addAlbum(input: AddInput): Promise<void> {
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
      created_by: currentUser?.id ?? null,
    });
    if (ins.error) {
      if ((ins.error as { code?: string }).code === '23505') {
        throw new Error('такой альбом у этого артиста уже есть');
      }
      throw ins.error;
    }
    await refreshData();
  } else {
    albums.push({
      id: 'a' + Date.now().toString(36),
      artist: input.artist,
      title: input.title,
      year: input.year,
      cover: input.coverDataUrl ?? input.coverUrl ?? '',
      tracksLocked: false,
      cohesion: null,
      albumType: null,
    });
    saveLocalAlbums();
  }
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

  let err: string | null = null;
  if (!artistRaw) err = 'Укажите артиста';
  else if (!titleRaw) err = 'Укажите название альбома';
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

  const artist = normalizeArtist(artistRaw);
  const dup = albums.some(
    (a) => a.artist.toLowerCase() === artist.toLowerCase() && a.title.toLowerCase() === titleRaw.toLowerCase(),
  );
  if (dup) {
    showTitleError('такой альбом у этого артиста уже есть');
    shakeEl(addPanel);
    return;
  }

  addPending = true;
  addSubmit.classList.add('is-loading');
  clearAddErrors();
  try {
    await addAlbum({
      artist,
      title: titleRaw,
      year: Number(yearRaw),
      coverDataUrl: pendingCover && pendingCover.startsWith('data:') ? pendingCover : null,
      coverUrl: pendingCover && !pendingCover.startsWith('data:') ? pendingCover : null,
    });
    addPending = false;
    addSubmit.classList.remove('is-loading');
    resetAddForm();
    renderAlbums();
    await swapTo(viewAdd, viewHome, () => { viewHome.scrollTop = 0; });
    toast('Альбом добавлен');
  } catch (e) {
    addPending = false;
    addSubmit.classList.remove('is-loading');
    showAddError(messageOf(e));
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

void init();
