// 방장 브라우저가 서버 역할을 하는 저장소 (PeerJS / WebRTC).
// 방장 창이 방 데이터 전체를 들고 있고(새로고침 대비로 localStorage에도 저장),
// 친구들은 방장에게 직접 접속해서 바뀔 때마다 전체 상태를 받는다. 쓰기는 방장에게 보내 반영한다.
const PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
const PREFIX = 'mm-table-jp-';
const HEARTBEAT = 4000;
const TIMEOUT = 15000;

let loading = null;
function loadPeerJs() {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = PEERJS_URL;
      s.onload = () => resolve(window.Peer);
      s.onerror = () => { loading = null; reject(new Error('연결 도구를 불러오지 못했어요. 인터넷 연결을 확인해 주세요.')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (v) => (v === undefined || v === null ? null : JSON.parse(JSON.stringify(v)));
const stable = (v) => {
  if (v === null || typeof v !== 'object') return JSON.stringify(v ?? null);
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  return `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${stable(v[k])}`).join(',')}}`;
};
const safeSend = (conn, msg) => { try { conn.send(msg); } catch (e) { console.warn('send failed', e); } };

function createTree() {
  let data = {};
  const listeners = new Set();
  const parts = (p) => p.split('/').filter(Boolean);
  const getAt = (p) => parts(p).reduce((o, k) => (o == null ? undefined : o[k]), data);
  const setAt = (p, v) => {
    const ks = parts(p);
    let o = data;
    for (let i = 0; i < ks.length - 1; i++) {
      if (typeof o[ks[i]] !== 'object' || o[ks[i]] === null) o[ks[i]] = {};
      o = o[ks[i]];
    }
    const last = ks[ks.length - 1];
    if (v === null || v === undefined) delete o[last];
    else o[last] = clone(v);
  };
  const emit = (l) => {
    const s = JSON.stringify(getAt(l.path) ?? null);
    if (s !== l.last) { l.last = s; l.cb(JSON.parse(s)); }
  };
  return {
    get data() { return data; },
    read: (p) => clone(getAt(p)),
    replace(next) { data = next || {}; listeners.forEach(emit); },
    apply(op) {
      if (op.t === 'set') setAt(op.p, op.v);
      else if (op.t === 'update') Object.entries(op.v || {}).forEach(([k, v]) => setAt(`${op.p}/${k}`, v));
      else if (op.t === 'remove') setAt(op.p, null);
      listeners.forEach(emit);
    },
    listen(path, cb) {
      const l = { path, cb, last: undefined };
      listeners.add(l);
      setTimeout(() => emit(l), 0);
      return () => listeners.delete(l);
    },
  };
}

export function peerStore() {
  const tree = createTree();
  let role = null;
  let code = null;
  let peer = null;
  let conn = null;
  let offset = 0;
  let beat = null;
  let lastHeard = 0;
  let reconnecting = false;
  let seq = 0;
  let statusCb = () => {};
  let saveTimer = null;
  let myPid = null;
  const pending = new Map();
  const clients = new Set();

  const saveKey = (c) => `mm-host:${c}`;
  function save() {
    if (role !== 'host' || !code) return;
    clearTimeout(saveTimer);
    const c = code;
    saveTimer = setTimeout(() => {
      try {
        if (tree.data.rooms?.[c]) localStorage.setItem(saveKey(c), JSON.stringify(tree.data));
        else localStorage.removeItem(saveKey(c));
      } catch { /* 저장 공간이 막혀 있으면 새로고침 때 이어지지 않을 뿐 */ }
    }, 200);
  }

  function makePeer(Peer, id) {
    return new Promise((resolve) => {
      const p = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
      let done = false;
      const finish = (r) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
      const t = setTimeout(() => { p.destroy(); finish({ err: 'timeout' }); }, 12000);
      p.on('open', () => finish({ peer: p }));
      p.on('error', (e) => { if (!done) { p.destroy(); finish({ err: e.type || 'error' }); } });
    });
  }

  /* ---- 방장 ---- */
  // 밀담(chats)은 그 대화에 들어 있는 사람에게만 보낸다.
  function viewFor(pid) {
    const d = tree.data;
    if (!d.rooms) return d;
    const rooms = {};
    for (const [c, r] of Object.entries(d.rooms)) {
      if (!r || !r.chats) { rooms[c] = r; continue; }
      const chats = {};
      for (const [tid, th] of Object.entries(r.chats)) if (pid && th?.members?.[pid]) chats[tid] = th;
      rooms[c] = { ...r, chats };
    }
    return { ...d, rooms };
  }
  const snapFor = (c) => ({ k: 'snap', tree: viewFor(c.pid), now: Date.now() });
  function broadcast() {
    clients.forEach((c) => { if (c.open) safeSend(c, snapFor(c)); });
  }
  function hostApply(op) {
    tree.apply(op);
    save();
    broadcast();
  }
  function dropClient(c) {
    if (!clients.has(c)) return;
    clients.delete(c);
    c.disc?.forEach((v, p) => hostApply({ t: 'update', p, v }));
    try { c.close(); } catch { /* 이미 닫힘 */ }
  }
  function onClientData(c, m) {
    c.lastHeard = Date.now();
    if (!m || typeof m !== 'object') return;
    if (m.k === 'hello') {
      c.pid = m.pid;
      safeSend(c, snapFor(c));
    } else if (m.k === 'op') {
      hostApply(m.op);
      safeSend(c, { k: 'ack', id: m.id });
    } else if (m.k === 'cas') {
      const cur = tree.read(m.p);
      if (stable(cur) === stable(m.expect)) {
        hostApply({ t: 'set', p: m.p, v: m.v });
        safeSend(c, { k: 'ack', id: m.id, committed: true });
      } else {
        safeSend(c, { k: 'ack', id: m.id, committed: false, value: cur });
      }
    } else if (m.k === 'ondisc') {
      (c.disc ||= new Map()).set(m.p, m.v);
    } else if (m.k === 'ondisc-cancel') {
      c.disc?.delete(m.p);
    }
  }
  async function openHost(c, fresh) {
    const Peer = await loadPeerJs();
    const tries = fresh ? 1 : 8;
    for (let i = 0; i < tries; i++) {
      const r = await makePeer(Peer, PREFIX + c);
      if (r.peer) {
        peer = r.peer;
        role = 'host';
        code = c;
        offset = 0;
        let saved = null;
        if (!fresh) { try { saved = JSON.parse(localStorage.getItem(saveKey(c))); } catch { saved = null; } }
        tree.replace(saved || {});
        peer.on('connection', (cn) => {
          cn.on('open', () => {
            cn.lastHeard = Date.now();
            clients.add(cn);
            safeSend(cn, snapFor(cn));
          });
          cn.on('data', (m) => onClientData(cn, m));
          cn.on('close', () => dropClient(cn));
          cn.on('error', () => dropClient(cn));
        });
        peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });
        beat = setInterval(() => {
          const now = Date.now();
          clients.forEach((cn) => {
            if (now - (cn.lastHeard || now) > TIMEOUT) dropClient(cn);
            else safeSend(cn, { k: 'ping', now });
          });
        }, HEARTBEAT);
        statusCb('ok');
        return { ok: true };
      }
      if (r.err !== 'unavailable-id' || fresh) return { ok: false, reason: r.err };
      await sleep(2500); // 새로고침 직후엔 예전 연결이 아직 이름을 잡고 있을 수 있다
    }
    return { ok: false, reason: 'unavailable-id' };
  }

  /* ---- 참가자 ---- */
  function onHostData(m) {
    lastHeard = Date.now();
    if (!m || typeof m !== 'object') return;
    if (m.k === 'snap') {
      offset = m.now - Date.now();
      tree.replace(m.tree);
    } else if (m.k === 'ack') {
      const p = pending.get(m.id);
      if (p) { pending.delete(m.id); p.resolve(m); }
    }
  }
  function connectHost() {
    return new Promise((resolve) => {
      let done = false;
      const cn = peer.connect(PREFIX + code, { reliable: true });
      const onErr = (e) => { if (e.type === 'peer-unavailable') finish(false); };
      const finish = (v) => {
        if (done) return;
        done = true;
        clearTimeout(t);
        peer.off('error', onErr);
        if (!v) { try { cn.close(); } catch { /* 무시 */ } }
        resolve(v);
      };
      const t = setTimeout(() => finish(false), 10000);
      peer.on('error', onErr);
      cn.on('data', (m) => {
        if (conn !== cn && m?.k === 'snap') {
          conn = cn;
          onHostData(m);
          if (myPid) safeSend(cn, { k: 'hello', pid: myPid });
          finish(true);
          return;
        }
        if (conn === cn) onHostData(m);
      });
      cn.on('close', () => { if (conn === cn) lost(); else finish(false); });
      cn.on('error', () => { if (conn === cn) lost(); else finish(false); });
    });
  }
  function lost() {
    if (!conn && reconnecting) return;
    conn = null;
    pending.forEach((p) => p.reject(new Error('방장과 연결이 끊겼어요.')));
    pending.clear();
    statusCb('lost');
    if (reconnecting) return;
    reconnecting = true;
    (async () => {
      while (reconnecting && role === 'client') {
        await sleep(3000);
        if (!reconnecting || role !== 'client' || !peer) break;
        if (peer.disconnected && !peer.destroyed) { try { peer.reconnect(); } catch { /* 다음 시도 */ } await sleep(1500); }
        if (await connectHost()) {
          reconnecting = false;
          lastHeard = Date.now();
          statusCb('ok');
        }
      }
    })();
  }
  async function openClient(c) {
    const Peer = await loadPeerJs();
    const r = await makePeer(Peer, null);
    if (!r.peer) return { ok: false, reason: r.err };
    peer = r.peer;
    role = 'client';
    code = c;
    peer.on('disconnected', () => { if (peer && !peer.destroyed) peer.reconnect(); });
    if (!(await connectHost())) {
      peer.destroy();
      peer = null;
      role = null;
      code = null;
      return { ok: false, reason: 'no-host' };
    }
    lastHeard = Date.now();
    beat = setInterval(() => {
      if (!conn) return;
      if (Date.now() - lastHeard > TIMEOUT) { try { conn.close(); } catch { /* 무시 */ } lost(); return; }
      safeSend(conn, { k: 'ping' });
    }, HEARTBEAT);
    statusCb('ok');
    return { ok: true };
  }
  function send(msg) {
    if (!conn) return Promise.reject(new Error('방장과 연결이 끊겨 있어요. 다시 연결되면 해 주세요.'));
    const id = ++seq;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      safeSend(conn, { ...msg, id });
      setTimeout(() => {
        if (pending.has(id)) { pending.delete(id); reject(new Error('방장이 응답하지 않아요.')); }
      }, 10000);
    });
  }
  function write(op) {
    if (role === 'client') return send({ k: 'op', op }).then(() => undefined);
    hostApply(op);
    return Promise.resolve();
  }

  const api = {
    mode: 'peer',
    get role() { return role; },
    now: () => Date.now() + offset,
    onStatus(cb) { statusCb = cb; },
    // 내가 누구인지 방장에게 알린다(밀담을 나에게 온 것만 받기 위해).
    identify(pid) {
      myPid = pid;
      if (role === 'client' && conn) safeSend(conn, { k: 'hello', pid });
    },
    open(c, as, opts = {}) { return as === 'host' ? openHost(c, !!opts.fresh) : openClient(c); },
    close() {
      clearInterval(beat);
      beat = null;
      reconnecting = false;
      clients.forEach((cn) => { try { cn.close(); } catch { /* 무시 */ } });
      clients.clear();
      conn = null;
      pending.clear();
      if (peer) peer.destroy();
      peer = null;
      role = null;
      code = null;
      myPid = null;
      tree.replace({});
    },
    get: async (p) => tree.read(p),
    set: (p, v) => write({ t: 'set', p, v: clone(v) }),
    update: (p, v) => write({ t: 'update', p, v: clone(v) }),
    remove: (p) => write({ t: 'remove', p }),
    push: async (p, v) => {
      const key = Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
      await api.set(`${p}/${key}`, v);
      return key;
    },
    listen: (p, cb) => tree.listen(p, cb),
    transaction: async (p, fn) => {
      if (role !== 'client') {
        const cur = tree.read(p);
        const next = fn(clone(cur));
        if (next === undefined) return { committed: false, value: cur };
        hostApply({ t: 'set', p, v: clone(next) });
        return { committed: true, value: next };
      }
      let cur = tree.read(p);
      for (let i = 0; i < 5; i++) {
        const next = fn(clone(cur));
        if (next === undefined) return { committed: false, value: cur };
        const r = await send({ k: 'cas', p, expect: cur, v: clone(next) });
        if (r.committed) return { committed: true, value: next };
        cur = r.value ?? null;
      }
      return { committed: false, value: cur };
    },
    onDisconnect: (p, v) => {
      if (role !== 'client' || !conn) return () => {};
      safeSend(conn, { k: 'ondisc', p, v: clone(v) });
      return () => { if (conn) safeSend(conn, { k: 'ondisc-cancel', p }); };
    },
  };
  return api;
}
