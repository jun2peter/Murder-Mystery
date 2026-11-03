// 실시간 저장소. firebase-config.js가 채워져 있으면 Firebase Realtime Database,
// 비어 있으면 같은 브라우저의 탭끼리만 연결되는 테스트 모드(localStorage)를 쓴다.
import { firebaseConfig } from './firebase-config.js';

const FIREBASE_VERSION = '10.12.2';

export async function createStore() {
  if (firebaseConfig && firebaseConfig.databaseURL) {
    try {
      return await firebaseStore(firebaseConfig);
    } catch (e) {
      console.error('Firebase 연결 실패, 테스트 모드로 전환', e);
    }
  }
  return localStore();
}

async function firebaseStore(config) {
  const base = `https://www.gstatic.com/firebasejs/${FIREBASE_VERSION}`;
  const { initializeApp } = await import(`${base}/firebase-app.js`);
  const fb = await import(`${base}/firebase-database.js`);
  const app = initializeApp(config);
  const db = fb.getDatabase(app);
  const r = (p) => fb.ref(db, p);

  let offset = 0;
  fb.onValue(r('.info/serverTimeOffset'), (s) => { offset = s.val() || 0; });

  return {
    mode: 'firebase',
    now: () => Date.now() + offset,
    get: async (p) => (await fb.get(r(p))).val(),
    set: (p, v) => fb.set(r(p), v),
    update: (p, obj) => fb.update(r(p), obj),
    remove: (p) => fb.remove(r(p)),
    push: async (p, v) => {
      const ref = fb.push(r(p));
      await fb.set(ref, v);
      return ref.key;
    },
    listen: (p, cb) => fb.onValue(r(p), (s) => cb(s.val())),
    transaction: async (p, fn) => {
      const res = await fb.runTransaction(r(p), fn);
      return { committed: res.committed, value: res.snapshot.val() };
    },
    // 창을 닫거나 연결이 끊기면 obj를 반영한다. 돌려주는 함수로 취소.
    onDisconnect: (p, obj) => {
      const od = fb.onDisconnect(r(p));
      od.update(obj);
      return () => od.cancel();
    },
  };
}

function localStore() {
  const KEY = 'mm-local-db';
  let memory = {};
  const listeners = new Set();
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const parts = (p) => p.split('/').filter(Boolean);

  const read = () => {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch { return clone(memory); }
  };
  const getAt = (tree, p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), tree);
  const setAt = (tree, p, v) => {
    const ks = parts(p);
    let o = tree;
    for (let i = 0; i < ks.length - 1; i++) {
      if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {};
      o = o[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (v === null || v === undefined) delete o[last];
    else o[last] = clone(v);
  };
  const emit = (l, tree) => {
    const s = JSON.stringify(getAt(tree, l.path) ?? null);
    if (s !== l.last) { l.last = s; l.cb(JSON.parse(s)); }
  };
  const notify = () => { const tree = read(); listeners.forEach((l) => emit(l, tree)); };
  const write = (tree) => {
    try { localStorage.setItem(KEY, JSON.stringify(tree)); } catch { memory = tree; }
    notify();
  };
  window.addEventListener('storage', (e) => { if (e.key === KEY) notify(); });

  const api = {
    mode: 'local',
    now: () => Date.now(),
    get: async (p) => clone(getAt(read(), p)) ?? null,
    set: async (p, v) => { const t = read(); setAt(t, p, v); write(t); },
    update: async (p, obj) => {
      const t = read();
      for (const [k, v] of Object.entries(obj)) setAt(t, `${p}/${k}`, v);
      write(t);
    },
    remove: async (p) => { const t = read(); setAt(t, p, null); write(t); },
    push: async (p, v) => {
      const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      await api.set(`${p}/${key}`, v);
      return key;
    },
    listen: (p, cb) => {
      const l = { path: p, cb, last: undefined };
      listeners.add(l);
      setTimeout(() => emit(l, read()), 0);
      return () => listeners.delete(l);
    },
    transaction: async (p, fn) => {
      const t = read();
      const cur = getAt(t, p);
      const next = fn(cur === undefined ? null : clone(cur));
      if (next === undefined) return { committed: false, value: cur ?? null };
      setAt(t, p, next);
      write(t);
      return { committed: true, value: next };
    },
    onDisconnect: (p, obj) => {
      const fn = () => { api.update(p, obj); };
      window.addEventListener('pagehide', fn);
      return () => window.removeEventListener('pagehide', fn);
    },
  };
  return api;
}
