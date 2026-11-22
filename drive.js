/* Sonora · Google Drive como fuente de música (solo lectura).
 *
 * Inicia sesión con Google (Google Identity Services), lee una carpeta de tu Drive
 * y suma sus canciones a la biblioteca. Las canciones se bajan al reproducirlas
 * (y la siguiente se prepara antes) porque el reproductor no puede enviar el
 * permiso de Google en cada petición. Título, artista y portada salen de las
 * etiquetas ID3 de cada archivo.
 *
 * Este archivo se carga antes del script principal: usa sus funciones (ls, DB,
 * state, toast, parseName, readTags…) solo cuando se llaman, nunca al cargar.
 */

// ID de cliente OAuth de Google Cloud. Puedes pegarlo aquí o desde la app (Google Drive → ID de cliente).
const DRIVE_CLIENT_ID = '';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_FOLDER = 'application/vnd.google-apps.folder';
const DRIVE_AUDIO = /\.(mp3|m4a|aac|wav|ogg|oga|opus|flac|webm|weba)$/i;
const DRIVE_MEM_TRACKS = 6;          // canciones que se guardan en memoria a la vez
const DRIVE_MAX_FILES = 5000;
const DRIVE_MAX_FOLDERS = 500;

// Id estable (con forma de UUID) para cada archivo de Drive, para que quepa en
// las playlists, que también se guardan en Supabase como uuid[].
function driveTid(fileId) {
  const s = 'gdrive:' + fileId;
  let h1 = 1779033703, h2 = 3144134277, h3 = 1013904242, h4 = 2773480762;
  for (let i = 0; i < s.length; i++) {
    const k = s.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  h1 ^= h2 ^ h3 ^ h4; h2 ^= h1; h3 ^= h1; h4 ^= h1;
  const x = [h1, h2, h3, h4].map(h => (h >>> 0).toString(16).padStart(8, '0')).join('');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-5${x.slice(13, 16)}-${(8 | (parseInt(x[16], 16) & 3)).toString(16)}${x.slice(17, 20)}-${x.slice(20, 32)}`;
}

const drive = {
  tokenClient: null, token: null, exp: 0,
  pending: null, _res: null, _rej: null,
  mem: [],                 // ids de canciones con el audio en memoria (la más vieja primero)
  loading: new Map(),      // id → Promise<url> mientras se baja
  metaIds: new Set(),      // archivos cuyas etiquetas ya se leyeron
  refreshing: false, scanning: false,

  settings() { return ls.get('sonora-drive', {}) || {}; },
  saveSettings(patch) { ls.set('sonora-drive', { ...this.settings(), ...patch }); },
  clientId() { return this.settings().clientId || DRIVE_CLIENT_ID; },
  get configured() { return !!this.clientId(); },
  get folder() { return this.settings().folder || null; },
  get enabled() { return !!this.folder; },
  get connected() { return !!this.token && Date.now() < this.exp - 60_000; },

  /* ---------- Sesión ---------- */
  restore() {
    const t = ls.get('sonora-drive-token', null);
    if (t?.token && Date.now() < t.exp - 60_000) { this.token = t.token; this.exp = t.exp; }
  },
  initClient() {
    if (this.tokenClient) return true;
    const id = this.clientId();
    if (!id || !window.google?.accounts?.oauth2) return false;
    this.tokenClient = google.accounts.oauth2.initTokenClient({
      client_id: id,
      scope: DRIVE_SCOPE,
      callback: r => this._onToken(r),
      error_callback: e => this._finish(new Error(
        e?.type === 'popup_closed' ? 'Se cerró la ventana de Google antes de terminar'
        : e?.type === 'popup_failed_to_open' ? 'El navegador bloqueó la ventana de Google. Permite las ventanas emergentes e inténtalo de nuevo'
        : 'No se pudo iniciar sesión con Google')),
    });
    return true;
  },
  _onToken(r) {
    if (r.error) return this._finish(new Error(r.error === 'access_denied' ? 'No diste permiso para leer tu Drive' : 'Google respondió: ' + (r.error_description || r.error)));
    if (!google.accounts.oauth2.hasGrantedAllScopes(r, DRIVE_SCOPE)) return this._finish(new Error('Falta el permiso para ver tus archivos de Drive. Vuelve a conectar y marca esa casilla'));
    this.token = r.access_token;
    this.exp = Date.now() + (+r.expires_in || 3600) * 1000;
    ls.set('sonora-drive-token', { token: this.token, exp: this.exp });
    this._finish(null, this.token);
  },
  _finish(err, token) {
    const res = this._res, rej = this._rej;
    this.pending = this._res = this._rej = null;
    err ? rej?.(err) : res?.(token);
  },
  // Con interactive, si la sesión venció abre la ventana de Google. Llamarla dentro
  // de un clic (sin await antes) para que el navegador no bloquee esa ventana.
  getToken(interactive = true) {
    if (this.connected) return Promise.resolve(this.token);
    if (!interactive) return Promise.reject(new Error('La sesión de Google Drive venció'));
    if (this.pending) return this.pending;
    if (!this.initClient()) return Promise.reject(new Error(this.configured ? 'No se pudo cargar el inicio de sesión de Google. ¿Hay conexión?' : 'Falta configurar Google Drive'));
    this.pending = new Promise((res, rej) => { this._res = res; this._rej = rej; });
    this.tokenClient.requestAccessToken({ prompt: '' });
    return this.pending;
  },
  forget() { this.token = null; this.exp = 0; ls.set('sonora-drive-token', null); },

  async api(path, { interactive = true, headers = {}, raw = false } = {}) {
    const token = await this.getToken(interactive);
    const res = await fetch(path.startsWith('http') ? path : DRIVE_API + path, { headers: { Authorization: 'Bearer ' + token, ...headers } });
    if (res.status === 401) { this.forget(); throw new Error('La sesión de Google venció. Toca actualizar para volver a conectar'); }
    if (res.status === 403) throw new Error('Google Drive negó el acceso (403). Revisa que la API de Drive esté activada en tu proyecto');
    if (!res.ok) throw new Error(`Google Drive respondió ${res.status}`);
    return raw ? res : res.json();
  },
  async listAll(q, fields, interactive = true) {
    const out = []; let pageToken = '';
    do {
      const p = new URLSearchParams({ q, fields: `nextPageToken,files(${fields})`, pageSize: '1000', orderBy: 'folder,name', supportsAllDrives: 'true', includeItemsFromAllDrives: 'true' });
      if (pageToken) p.set('pageToken', pageToken);
      const r = await this.api('/files?' + p, { interactive });
      out.push(...(r.files || []));
      pageToken = r.nextPageToken;
    } while (pageToken);
    return out;
  },
  listFolders(parentId) {
    return this.listAll(`'${parentId}' in parents and mimeType='${DRIVE_FOLDER}' and trashed=false`, 'id,name');
  },

  /* ---------- Carpeta y biblioteca ---------- */
  // Recorre la carpeta elegida y sus subcarpetas buscando archivos de audio.
  async scan(interactive) {
    const out = []; const queue = [{ id: this.folder.id, name: '' }]; let folders = 0;
    while (queue.length && out.length < DRIVE_MAX_FILES && folders < DRIVE_MAX_FOLDERS) {
      const dir = queue.shift(); folders++;
      const kids = await this.listAll(`'${dir.id}' in parents and trashed=false`, 'id,name,mimeType,size,modifiedTime,createdTime', interactive);
      for (const k of kids) {
        if (k.mimeType === DRIVE_FOLDER) queue.push({ id: k.id, name: k.name });
        else if (k.mimeType?.startsWith('audio/') || DRIVE_AUDIO.test(k.name)) out.push({
          id: k.id, tid: driveTid(k.id), name: k.name, mime: k.mimeType, size: +k.size || 0,
          modifiedTime: k.modifiedTime, createdTime: k.createdTime, folderName: dir.name,
        });
      }
    }
    return out.slice(0, DRIVE_MAX_FILES);
  },
  localMeta() { return ls.get('sonora-drive-local', {}) || {}; },
  saveLocal(t) {
    const m = this.localMeta();
    m[t.id] = { liked: !!t.liked, duration: isFinite(t.duration) ? t.duration : null };
    ls.set('sonora-drive-local', m);
  },
  // Archivos sin etiquetas: el nombre puede ser «Artista - Título» o «Título - Artista».
  get titleFirst() { return this.settings().nameOrder === 'title-artist'; },
  toTrack(f, meta, local, download) {
    const p = parseName(f.name);
    if (this.titleFirst && p.artist) [p.artist, p.title] = [p.title, p.artist];
    const t = {
      id: f.tid, kind: 'gdrive', fileId: f.id, mime: f.mime, size: f.size,
      ext: (f.name.match(/\.([a-z0-9]+)$/i)?.[1] || 'mp3').toLowerCase(),
      title: meta?.title || p.title || f.name,
      artist: meta?.artist || p.artist || 'Artista desconocido',
      album: meta?.album || f.folderName || '',
      duration: local?.duration ?? NaN, liked: !!local?.liked,
      addedAt: Date.parse(f.createdTime || f.modifiedTime) || 0,
      url: null, coverUrl: meta?.coverBlob ? URL.createObjectURL(meta.coverBlob) : null, offline: false,
    };
    if (download) { t.offline = true; t.url = URL.createObjectURL(download.blob); }
    return t;
  },
  // Arma las canciones desde la copia guardada del listado. Sin internet, solo las descargadas.
  async build(prev = new Map()) {
    const cache = ls.get('sonora-drive-cache', null);
    if (!this.enabled || !cache || cache.folderId !== this.folder.id) return [];
    const [metas, downloads] = await Promise.all([DB.all('drivemeta').catch(() => []), DB.all('offline').catch(() => [])]);
    const mm = new Map(metas.map(m => [m.id, m]));
    const dm = new Map(downloads.filter(d => d.userId === 'gdrive').map(d => [d.id, d]));
    const local = this.localMeta();
    const online = navigator.onLine;
    this.metaIds = new Set();
    this.mem = [];
    const out = [];
    for (const f of cache.files) {
      const m = mm.get(f.id);
      const meta = m && m.modifiedTime === f.modifiedTime ? m : null;
      if (meta) this.metaIds.add(f.id);
      const old = prev.get(f.tid);
      const t = this.toTrack(f, meta, local[f.tid], old?.offline ? null : dm.get(f.tid));
      if (old) {
        // Conserva el audio ya bajado (puede estar sonando) en vez de bajarlo otra vez.
        if (old.url) { t.url = old.url; t.offline = old.offline; if (!old.offline) this.mem.push(t.id); }
        if (old.coverUrl && !meta?.coverBlob) t.coverUrl = old.coverUrl;
        if (isFinite(old.duration)) t.duration = old.duration;
      }
      if (!online && !t.offline) continue;
      out.push(t);
    }
    return out;
  },
  async merge() { (await this.build()).forEach(t => state.tracks.set(t.id, t)); },
  // Vuelve a armar las canciones de Drive sin cortar lo que esté sonando.
  async remerge() {
    const prev = new Map([...state.tracks].filter(([, t]) => t.kind === 'gdrive'));
    const tracks = await this.build(prev);
    for (const id of prev.keys()) state.tracks.delete(id);
    tracks.forEach(t => state.tracks.set(t.id, t));
    const curId = state.queue[state.qi];
    state.queue = state.queue.filter(id => state.tracks.has(id));
    state.origQueue = state.origQueue.filter(id => state.tracks.has(id));
    state.qi = curId ? state.queue.indexOf(curId) : -1;
    renderAll();
  },
  async refresh(interactive = true) {
    if (!this.enabled) return openDrivePanel();
    if (this.refreshing) return;
    this.refreshing = true;
    if (interactive) toast('Buscando canciones en tu Drive…');
    try {
      const files = await this.scan(interactive);
      ls.set('sonora-drive-cache', { folderId: this.folder.id, at: Date.now(), files });
      await this.remerge();
      if (interactive) toast(files.length ? `${countLabel(files.length)} en tu carpeta de Drive` : 'No encontré archivos de audio en esa carpeta');
      this.scanTags();
    } catch (e) {
      console.warn(e);
      if (interactive) toast(e.message || 'No se pudo leer tu Drive');
    } finally { this.refreshing = false; }
  },
  async disconnect() {
    if (this.token && window.google?.accounts?.oauth2) try { google.accounts.oauth2.revoke(this.token, () => {}); } catch {}
    this.forget();
    this.saveSettings({ folder: null });
    ls.set('sonora-drive-cache', null);
    for (const d of (await DB.all('offline').catch(() => [])).filter(d => d.userId === 'gdrive')) await DB.del('offline', d.id).catch(() => {});
    const cur = current();
    if (cur?.kind === 'gdrive') { audio.pause(); audio.removeAttribute('src'); audio.load(); }
    for (const [id, t] of [...state.tracks]) {
      if (t.kind !== 'gdrive') continue;
      if (t.url?.startsWith('blob:')) URL.revokeObjectURL(t.url);
      if (t.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(t.coverUrl);
      state.tracks.delete(id);
    }
    state.queue = state.queue.filter(id => state.tracks.has(id));
    state.origQueue = state.origQueue.filter(id => state.tracks.has(id));
    state.qi = cur && state.tracks.has(cur.id) ? state.queue.indexOf(cur.id) : -1;
    if (state.source === 'drive') state.source = null;
    this.mem = [];
    updateNowPlaying(); updatePlayIcons();
    navigate(state.view.key === 'drive' ? 'home' : state.view.name, state.view.key === 'drive' ? undefined : state.view.key, false);
    toast('Google Drive desconectado');
  },

  /* ---------- Audio ---------- */
  // Baja la canción (si no está ya en memoria o descargada) y devuelve una URL reproducible.
  resolve(t, interactive = true) {
    if (t.url) return Promise.resolve(t.url);
    if (this.loading.has(t.id)) return this.loading.get(t.id);
    const p = (async () => {
      const res = await this.api(`/files/${t.fileId}?alt=media&supportsAllDrives=true`, { raw: true, interactive });
      let blob = await res.blob();
      if (!blob.type.startsWith('audio/')) blob = new Blob([blob], { type: t.mime?.startsWith('audio/') ? t.mime : AUDIO_TYPES[t.ext] || 'audio/mpeg' });
      const live = state.tracks.get(t.id) || t;   // el listado pudo actualizarse mientras bajaba
      if (live.url) return live.url;
      live.url = URL.createObjectURL(blob);
      this.remember(live);
      if (!this.metaIds.has(live.fileId)) readTags(blob).then(tags => this.saveTags({ id: live.fileId, modifiedTime: this.fileOf(live.fileId)?.modifiedTime }, tags)).catch(() => {});
      return live.url;
    })().finally(() => this.loading.delete(t.id));
    this.loading.set(t.id, p);
    return p;
  },
  // Guarda pocas canciones en memoria: libera las más viejas que no estén sonando.
  remember(t) {
    this.mem = this.mem.filter(id => id !== t.id);
    this.mem.push(t.id);
    while (this.mem.length > DRIVE_MEM_TRACKS) {
      const i = this.mem.findIndex(id => id !== current()?.id);
      if (i < 0) break;
      const [id] = this.mem.splice(i, 1);
      const old = state.tracks.get(id);
      if (old && !old.offline && old.url?.startsWith('blob:')) { URL.revokeObjectURL(old.url); old.url = null; }
    }
  },
  async blob(t) {
    const url = await this.resolve(t);
    return (await fetch(url)).blob();
  },
  // Prepara la siguiente canción de la cola mientras suena la actual.
  prefetchNext() {
    const t = state.tracks.get(state.queue[state.qi + 1]);
    if (t?.kind === 'gdrive' && !t.url && this.connected) this.resolve(t, false).catch(() => {});
  },

  /* ---------- Etiquetas (título, artista, álbum, portada) ---------- */
  fileOf(fileId) { return ls.get('sonora-drive-cache', null)?.files.find(f => f.id === fileId); },
  async saveTags(f, tags) {
    if (!f?.id) return;
    const rec = { id: f.id, modifiedTime: f.modifiedTime, title: tags.title?.trim() || '', artist: tags.artist?.trim() || '', album: tags.album?.trim() || '', coverBlob: tags.coverBlob || null };
    await DB.put('drivemeta', rec).catch(() => {});
    this.metaIds.add(f.id);
    const t = state.tracks.get(driveTid(f.id));
    if (!t) return;
    if (rec.title) t.title = rec.title;
    if (rec.artist) t.artist = rec.artist;
    if (rec.album) t.album = rec.album;
    if (rec.coverBlob) { if (t.coverUrl?.startsWith('blob:')) URL.revokeObjectURL(t.coverUrl); t.coverUrl = URL.createObjectURL(rec.coverBlob); }
    if (current()?.id === t.id) updateNowPlaying();
  },
  // Lee solo el principio de cada archivo (donde van las etiquetas ID3), no la canción entera.
  async readRemoteTags(f) {
    const get = end => this.api(`/files/${f.id}?alt=media&supportsAllDrives=true`, { raw: true, interactive: false, headers: { Range: `bytes=0-${end}` } }).then(r => r.arrayBuffer());
    let buf = new Uint8Array(await get(262143));
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {           // "ID3"
      const size = ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) | ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
      const need = size + 10 + (buf[5] & 0x10 ? 10 : 0);
      if (need > buf.length && need <= 8 * 1024 * 1024 && (!f.size || buf.length < f.size)) buf = new Uint8Array(await get(need + 4095));
    }
    return readTags(new Blob([buf], { type: f.mime || 'audio/mpeg' }));
  },
  async scanTags() {
    if (this.scanning || !this.connected) return;
    this.scanning = true;
    try {
      const cache = ls.get('sonora-drive-cache', null);
      const metas = new Map((await DB.all('drivemeta').catch(() => [])).map(m => [m.id, m]));
      const todo = (cache?.files || []).filter(f => metas.get(f.id)?.modifiedTime !== f.modifiedTime && !this.metaIds.has(f.id));
      let done = 0;
      const worker = async () => {
        while (todo.length && this.connected) {
          const f = todo.shift();
          try { await this.saveTags(f, await this.readRemoteTags(f)); }
          catch (e) { console.warn('Etiquetas de', f.name, e); await this.saveTags(f, {}); }
          if (++done % 15 === 0) renderAll();
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (done) renderAll();
    } finally { this.scanning = false; }
  },
};

/* ---------- Ventanas de Google Drive ---------- */
const driveBtn = {
  primary: 'px-6 py-2 rounded-full bg-white text-black font-bold hover:scale-105 transition disabled:opacity-50 disabled:hover:scale-100',
  ghost: 'px-4 py-2 rounded-full font-bold text-zinc-300 hover:text-white transition',
  row: 'w-full flex items-center gap-3 p-3 rounded-lg hover:bg-white/10 text-left',
};
function driveSheet(title, body) {
  closeMenu();
  const wrap = document.createElement('div');
  wrap.className = 'fixed inset-0 z-[55] bg-black/70 grid place-items-center p-4';
  wrap.innerHTML = `<form class="w-full max-w-md max-h-[88vh] flex flex-col gap-4 bg-[#282828] rounded-xl p-6 shadow-2xl">
    <h2 class="text-xl font-bold flex items-center gap-2"><span class="w-6 h-6 shrink-0 text-accent">${icon('cloud')}</span>${esc(title)}</h2>
    ${body}</form>`;
  document.body.appendChild(wrap);
  const form = wrap.querySelector('form');
  const dismiss = () => wrap.remove();
  const close = () => { wrap.remove(); hist.closeOverlay(dismiss); };
  hist.openOverlay(dismiss);
  wrap.addEventListener('mousedown', e => { if (e.target === wrap) close(); });
  wrap.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
  const showErr = msg => { const el = form.querySelector('[data-d=err]'); if (!el) return toast(msg); el.textContent = msg; el.classList.remove('hidden'); };
  return { form, close, showErr };
}

function openDrivePanel() {
  const { primary, ghost, row } = driveBtn;
  const f = drive.folder;
  const n = [...state.tracks.values()].filter(t => t.kind === 'gdrive').length;
  let body;
  if (!window.isSecureContext) body = `
    <p class="text-zinc-300">Google Drive solo funciona si abres la app desde <span class="text-white">https://</span> (por ejemplo, tu sitio de Netlify) o desde <span class="text-white">localhost</span>, no como archivo suelto.</p>
    <div class="flex justify-end"><button type="button" data-d="close" class="${primary}">Entendido</button></div>`;
  else if (!drive.configured) body = `
    <p class="text-sm text-zinc-300">Para leer tu Drive, Google pide un <span class="text-white">ID de cliente</span> que creas gratis en Google Cloud. Tienes los pasos en el archivo <span class="text-white">GOOGLE-DRIVE-SETUP.md</span>, junto a la app.</p>
    <label class="block"><span class="text-sm text-zinc-300">ID de cliente</span>
      <input name="clientId" required autocomplete="off" placeholder="1234…apps.googleusercontent.com"
        class="mt-1 w-full rounded-md bg-white/10 border border-transparent focus:border-zinc-300 outline-none px-3 py-2 select-text"></label>
    <p data-d="err" class="text-sm text-red-400 hidden"></p>
    <div class="flex justify-end gap-2"><button type="button" data-d="close" class="${ghost}">Cancelar</button><button class="${primary}">Guardar</button></div>`;
  else if (!window.google?.accounts?.oauth2) body = `
    <p class="text-zinc-300">No se pudo cargar el inicio de sesión de Google. Revisa tu conexión a internet y vuelve a abrir esta ventana.</p>
    <div class="flex justify-end"><button type="button" data-d="close" class="${primary}">Entendido</button></div>`;
  else if (!f) body = `
    <p class="text-sm text-zinc-300">Conecta tu cuenta de Google y elige la carpeta donde está tu música. La app solo <span class="text-white">lee</span> tus archivos: nunca cambia ni borra nada de tu Drive.</p>
    <p data-d="err" class="text-sm text-red-400 hidden"></p>
    <button type="button" data-d="connect" class="${primary} w-full py-3">Conectar con Google</button>
    <div class="flex items-center justify-between">
      <button type="button" data-d="reset" class="text-sm text-zinc-400 hover:text-white">Cambiar ID de cliente</button>
      <button type="button" data-d="close" class="${ghost}">Cancelar</button>
    </div>`;
  else body = `
    <div class="flex items-center gap-3 p-3 rounded-lg bg-white/5">
      <span class="w-10 h-10 shrink-0 rounded-full bg-accent text-black grid place-items-center">${icon('folder', 'w-5 h-5')}</span>
      <div class="min-w-0">
        <div class="font-semibold truncate" title="${esc(f.path || f.name)}">${esc(f.path || f.name)}</div>
        <div class="text-sm text-zinc-400">${countLabel(n)} · ${drive.connected ? '<span class="text-accent">conectado</span>' : '<span class="text-amber-400">sesión vencida</span>'}</div>
      </div>
    </div>
    <p data-d="err" class="text-sm text-red-400 hidden"></p>
    <div class="-mx-3">
      <button type="button" data-d="refresh" class="${row}"><span class="w-5 h-5 shrink-0">${icon('refresh')}</span>
        <span><span class="block font-semibold">Actualizar ahora</span><span class="block text-sm text-zinc-400">Busca canciones nuevas en la carpeta${drive.connected ? '' : ' (te pedirá entrar con Google)'}</span></span></button>
      <button type="button" data-d="folder" class="${row}"><span class="w-5 h-5 shrink-0">${icon('folder')}</span>
        <span><span class="block font-semibold">Elegir otra carpeta</span><span class="block text-sm text-zinc-400">Se incluyen también sus subcarpetas</span></span></button>
      <button type="button" data-d="order" class="${row}"><span class="w-5 h-5 shrink-0">${icon('note')}</span>
        <span><span class="block font-semibold">Nombres de archivo: ${drive.titleFirst ? 'Título - Artista' : 'Artista - Título'}</span><span class="block text-sm text-zinc-400">Para canciones sin etiquetas. Toca para cambiar el orden</span></span></button>
    </div>
    <div class="flex items-center justify-between">
      <button type="button" data-d="logout" class="text-sm text-zinc-400 hover:text-white">Desconectar Drive</button>
      <button type="button" data-d="close" class="${primary}">Listo</button>
    </div>`;

  const s = driveSheet('Google Drive', body);
  s.form.addEventListener('click', e => {
    const d = e.target.closest('[data-d]')?.dataset.d;
    if (d === 'close') s.close();
    else if (d === 'connect') drive.getToken(true).then(() => { s.close(); openFolderPicker(); }).catch(err => s.showErr(err.message));
    else if (d === 'folder') drive.getToken(true).then(() => { s.close(); openFolderPicker(); }).catch(err => s.showErr(err.message));
    else if (d === 'refresh') { s.close(); drive.refresh(true); }
    else if (d === 'order') {
      drive.saveSettings({ nameOrder: drive.titleFirst ? 'artist-title' : 'title-artist' });
      s.close(); drive.remerge().then(() => { updateNowPlaying(); openDrivePanel(); });
    }
    else if (d === 'reset') { drive.saveSettings({ clientId: '' }); drive.tokenClient = null; drive.forget(); s.close(); openDrivePanel(); }
    else if (d === 'logout') {
      if (!confirm('¿Desconectar Google Drive? Sus canciones dejarán de aparecer en la app. No se borra nada de tu Drive.')) return;
      s.close(); drive.disconnect();
    }
  });
  s.form.addEventListener('submit', e => {
    e.preventDefault();
    const id = String(new FormData(s.form).get('clientId') || '').trim();
    if (!/^[\w-]+\.apps\.googleusercontent\.com$/.test(id)) return s.showErr('El ID de cliente termina en .apps.googleusercontent.com');
    drive.saveSettings({ clientId: id }); drive.tokenClient = null; drive.forget();
    s.close(); openDrivePanel();
  });
  s.form.querySelector('input')?.focus();
}

function openFolderPicker() {
  const { primary, ghost } = driveBtn;
  const trail = [{ id: 'root', name: 'Mi unidad' }];
  const s = driveSheet('Elige la carpeta de tu música', `
    <div data-crumbs class="flex flex-wrap items-center gap-1 text-sm text-zinc-400"></div>
    <div data-list class="flex-1 min-h-[180px] overflow-y-auto -mx-2"></div>
    <div class="flex justify-end gap-2"><button type="button" data-d="close" class="${ghost}">Cancelar</button><button type="button" data-d="use" class="${primary}">Usar esta carpeta</button></div>`);
  const crumbs = s.form.querySelector('[data-crumbs]');
  const list = s.form.querySelector('[data-list]');
  let seq = 0;
  async function show() {
    const my = ++seq;
    crumbs.innerHTML = trail.map((f, i) => `<button type="button" data-d="crumb" data-i="${i}" class="hover:text-white ${i === trail.length - 1 ? 'text-white font-semibold' : ''}">${esc(f.name)}</button>`)
      .join(`<span class="w-4 h-4 text-zinc-600">${icon('chevronRight')}</span>`);
    list.innerHTML = '<p class="px-2 py-8 text-center text-zinc-400">Cargando carpetas…</p>';
    try {
      const folders = await drive.listFolders(trail[trail.length - 1].id);
      if (my !== seq) return;
      list.innerHTML = folders.length
        ? folders.map(f => `<button type="button" data-d="open" data-id="${esc(f.id)}" data-name="${esc(f.name)}" class="w-full flex items-center gap-3 px-2 py-2.5 rounded-md hover:bg-white/10 text-left">
            <span class="w-5 h-5 shrink-0 text-zinc-400">${icon('folder')}</span><span class="flex-1 truncate">${esc(f.name)}</span><span class="w-5 h-5 shrink-0 text-zinc-600">${icon('chevronRight')}</span></button>`).join('')
        : '<p class="px-2 py-8 text-center text-zinc-400">No hay subcarpetas aquí. Puedes usar esta carpeta.</p>';
    } catch (e) {
      if (my === seq) list.innerHTML = `<p class="px-2 py-8 text-center text-red-400">${esc(e.message)}</p>`;
    }
  }
  s.form.addEventListener('click', e => {
    const b = e.target.closest('[data-d]'); if (!b) return;
    const d = b.dataset.d;
    if (d === 'close') s.close();
    else if (d === 'open') { trail.push({ id: b.dataset.id, name: b.dataset.name }); show(); }
    else if (d === 'crumb') { trail.length = +b.dataset.i + 1; show(); }
    else if (d === 'use') {
      const f = trail[trail.length - 1];
      drive.saveSettings({ folder: { id: f.id, name: f.name, path: trail.map(x => x.name).join(' / ') } });
      ls.set('sonora-drive-cache', null);
      s.close();
      drive.refresh(true).then(() => { if (drive.enabled) navigate('playlist', 'drive'); });
    }
  });
  show();
}
