// 실시간 저장소. firebase-config.js가 채워져 있으면 Firebase Realtime Database,
// 비어 있으면 방장 브라우저가 서버 역할을 하는 방장 모드(peer.js)를 쓴다.
import { firebaseConfig } from './firebase-config.js';
import { peerStore } from './peer.js';

const FIREBASE_VERSION = '10.12.2';

export async function createStore() {
  if (firebaseConfig && firebaseConfig.databaseURL) {
    try {
      return await firebaseStore(firebaseConfig);
    } catch (e) {
      console.error('Firebase 연결 실패, 방장 모드로 전환', e);
    }
  }
  return peerStore();
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
    role: null,
    now: () => Date.now() + offset,
    open: async () => ({ ok: true }),
    close: () => {},
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
