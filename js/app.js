import { createStore } from './store.js';
import * as Lock from './locked.js';
import { renderPdf } from './pdfview.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_TTL = 12 * 3600 * 1000;
const TRANSLATE_URL = 'https://translate.google.com/?sl=ja&tl=ko&op=images';

const S = {
  store: null,
  themes: [],
  byId: {},
  view: 'home',
  code: null,
  pid: null,
  room: null,
  theme: null,
  key: null,
  unsub: null,
  cancelDisc: null,
  lobby: {},
  selTheme: null,
  inviteCode: '',
  armed: null,
  arrived: null,
  dealt: new Set(),
  modal: null,
  modalSig: null,
  doc: { file: null, title: '', zoom: 1, bytes: null, kind: 'pdf', help: false },
  files: new Map(),
  pending: new Set(),
  seen: { phase: null, round: null },
  conn: 'ok',
  chat: { open: false, view: 'list', tid: null, picks: [], sig: null, unread: 0 },
};

/* ---------- 작은 도구들 ---------- */
const $ = (s, r = document) => r.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const safe = (fn) => { try { return fn(); } catch { return null; } };
const sGet = (k) => safe(() => sessionStorage.getItem(k));
const sSet = (k, v) => safe(() => (v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v)));
const lGet = (k) => safe(() => localStorage.getItem(k));
const lSet = (k, v) => safe(() => (v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v)));
const pick = (n, chars) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => chars[b % chars.length]).join('');
const newId = () => pick(12, 'abcdefghijkmnpqrstuvwxyz23456789');
const newCode = () => pick(4, CODE_CHARS);
const shuffle = (arr) => {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = crypto.getRandomValues(new Uint32Array(1))[0] % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};
const tilt = (id, span) => {
  let h = 7;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) | 0;
  return ((Math.abs(h) % (span * 20)) / 10 - span).toFixed(1);
};
const fmtTime = (ms) => {
  const s = Math.ceil(ms / 1000);
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};
const clock = (t) => new Date(t).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2800);
}
async function busy(p) {
  try { await p; } catch (err) { console.error(err); toast(err.message || String(err)); }
}

/* ---------- 테마 ---------- */
// 인원별 버전이 있는 테마는 고른 버전으로 캐릭터·자료·카드를 채운다. '@키'는 fileMap에서 찾는다.
function resolveTheme(t, v) {
  if (!t.variants) return t;
  const key = t.variants[v] ? v : Object.keys(t.variants).pop();
  const vv = t.variants[key];
  const f = (p) => (p && p.startsWith('@') ? t.fileMap?.[`${key}:${p.slice(1)}`] : p);
  const characters = vv.characters.map((id) => ({
    id,
    ...t.characterInfo[id],
    cover: t.charCover ? f(`@${id}:${t.charCover}`) : null,
    docs: (t.charDocs || []).map((d) => ({ ...d, file: f(`@${id}:${d.key}`) })),
    endDocs: (t.charEndDocs || []).map((d) => ({ ...d, file: f(`@${id}:${d.key}`) })),
  }));
  return {
    ...t,
    ...vv,
    variant: key,
    characters,
    docs: (t.docs || []).map((d) => ({ ...d, file: f(d.file) })),
    cards: (vv.cards || t.cards || []).map((c) => ({ ...c, file: f(c.file) })),
    rounds: t.rounds.map((r) => (r.minutesByVariant ? { ...r, minutes: r.minutesByVariant[key] ?? r.minutes } : r)),
  };
}
const isPdf = (t) => t.kind === 'pdf';
const themeLabel = (t) => (t.no ? `테마 ${t.no}` : t.label || '샘플');
const totalMinutes = (t) => t.rounds.reduce((s, r) => s + (r.minutes || 0), 0);
const themePortraits = (t) => (t.characters || Object.values(t.characterInfo || {})).map((c) => c.img).filter(Boolean);
const imgUrl = (p, t = S.theme) => (p ? t.base + p : '');
const cardRules = () => ({ public: true, share: true, give: true, ...(S.theme.cardRules || {}) });

/* ---------- 방 상태 읽기 ---------- */
const roomPath = (p = '') => `rooms/${S.code}${p ? `/${p}` : ''}`;
const meta = () => S.room?.meta || {};
const phase = () => meta().phase;
const roundNo = () => meta().round ?? 0;
const players = () => Object.entries(S.room?.players || {})
  .filter(([, p]) => p && p.name)
  .map(([id, p]) => ({ id, ...p }))
  .sort((a, b) => (a.joinedAt || 0) - (b.joinedAt || 0));
const actors = () => players().filter((p) => !p.gm);
const me = () => S.room?.players?.[S.pid] || {};
const isGM = () => !!me().gm;
const hostId = () => meta().host || players()[0]?.id;
const isHost = () => hostId() === S.pid;
const held = () => meta().hold === meta().round;
const charOf = (id) => S.theme?.characters.find((c) => c.id === id) || null;
const holderOf = (charId) => actors().find((p) => p.char === charId) || null;
const who = (pid) => {
  const p = S.room?.players?.[pid];
  if (!p) return '누군가';
  const c = charOf(p.char);
  return c ? `${p.name}(${c.name})` : p.name;
};
const cardOf = (id) => S.theme.cards.find((c) => c.id === id);
const cardState = (id) => S.room?.cards?.[id] || {};
const locName = (id) => S.theme.locations?.find((l) => l.id === id)?.name || id;
const cardNo = (c) => String(S.theme.cards.filter((x) => x.location === c.location).indexOf(c) + 1).padStart(2, '0');
const cardTag = (c) => c.title && c.file ? c.title : `${locName(c.location)} ${cardNo(c)}`;
const canSee = (id) => {
  const st = cardState(id);
  return st.owner === S.pid || st.public || !!st.shared?.[S.pid] || isGM() || phase() === 'end';
};
// 자료가 열리는 단계에 왔는지
const reached = (from = 0) => ['vote', 'end'].includes(phase()) || (phase() === 'play' && roundNo() >= from);
const log = (m) => S.store.push(roomPath('log'), { t: S.store.now(), m });

function avatar(pid, size = '') {
  const p = S.room?.players?.[pid];
  const c = p && charOf(p.char);
  if (c?.img) return `<span class="ava ${size}"><img src="${esc(imgUrl(c.img))}" alt=""></span>`;
  return `<span class="ava ava-text ${size}">${esc((p?.name || '?').trim().slice(0, 1))}</span>`;
}

/* ---------- 시작 ---------- */
async function boot() {
  S.store = await createStore();
  try {
    const ids = await fetch('themes/index.json', { cache: 'no-store' }).then((r) => r.json());
    S.themes = await Promise.all(ids.map((id) => fetch(`themes/${id}/theme.json`, { cache: 'no-store' })
      .then((r) => r.json())
      .then((t) => ({ ...t, id, base: `themes/${id}/` }))));
  } catch (e) {
    $('#view').innerHTML = `<p class="warn">테마 목록을 불러오지 못했어요. (${esc(e.message)})</p>`;
    return;
  }
  S.byId = Object.fromEntries(S.themes.map((t) => [t.id, t]));
  if (isPeer()) S.store.onStatus(onConnStatus);
  else S.store.listen('lobby', (v) => { S.lobby = v || {}; if (S.view === 'home') render(); });

  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  document.addEventListener('change', onChange);
  setInterval(tick, 1000);

  const q = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const cur = safe(() => JSON.parse(sGet('mm:cur')));
  if (cur?.code && (!q || q === cur.code)) {
    $('#view').innerHTML = '<p class="boot">방에 다시 연결하고 있어요…</p>';
    const r = await S.store.open(cur.code, cur.role === 'host' ? 'host' : 'join');
    if (r.ok && (await enterRoom(cur.code, cur.pid))) return;
    S.store.close();
  }
  S.inviteCode = q;
  render();
}

const isPeer = () => S.store?.mode === 'peer';
const isServerHost = () => isPeer() && S.store.role === 'host';

// 방장 모드에서 방장과의 연결 상태가 바뀔 때
function onConnStatus(s) {
  const was = S.conn;
  S.conn = s;
  if (S.view !== 'room') return;
  if (s === 'ok' && was === 'lost' && S.store.role === 'client') {
    S.store.update(roomPath(`players/${S.pid}`), { online: true }).catch(() => {});
    S.cancelDisc = S.store.onDisconnect(roomPath(`players/${S.pid}`), { online: false });
    toast('방장과 다시 연결됐어요.');
  }
  render();
}

/* ---------- 그리기 ---------- */
function render() {
  const view = $('#view');
  const keep = {};
  view.querySelectorAll('input[id], select[id]').forEach((i) => { if (i.type !== 'checkbox' && i.type !== 'radio') keep[i.id] = i.value; });
  const focusId = document.activeElement?.id;

  if (S.view === 'home') renderHome(); else renderRoom();

  for (const [id, v] of Object.entries(keep)) {
    const i = document.getElementById(id);
    if (i && view.contains(i)) i.value = v;
  }
  if (focusId) {
    const el = document.getElementById(focusId);
    if (el && view.contains(el)) el.focus();
  }
  renderModal();
  renderChat();
}

function renderHome() {
  const name = lGet('mm:name') || '';
  const t = S.selTheme ? S.byId[S.selTheme] : null;
  const last = safe(() => JSON.parse(lGet('mm:last')));
  $('#view').innerHTML = `
  <div class="home">
    <header class="masthead">
      <p class="eyebrow">온라인 머더 미스터리</p>
      <h1 class="wordmark">머더 미스터리<br><em>테이블</em></h1>
      <p class="lede">테마를 고르고 이름을 적은 뒤 같은 방에 모이세요. 캐릭터는 모두가 동의해야 확정되고, 단서는 테이블에 펼쳐 놓고 가져가요.</p>
    </header>
    ${isPeer() ? '<p class="notice"><strong>방장 모드</strong> · 방을 만든 사람의 브라우저가 게임을 진행해요. 친구들에게 방 코드나 초대 링크를 보내 주세요. 방장은 게임이 끝날 때까지 창을 닫지 마세요.</p>' : ''}
    ${last ? `<p class="notice">최근에 있던 방 <strong>${esc(last.code)}</strong> · ${esc(last.title || '')}${last.role === 'host' ? ' · 내가 방장' : ''}
      <button class="btn ghost sm" data-act="resume" data-code="${esc(last.code)}" data-name="${esc(last.name)}" data-role="${last.role === 'host' ? 'host' : 'join'}">${esc(last.name)}(으)로 다시 들어가기</button></p>` : ''}
    <div class="home-cols">
      <section>
        <p class="eyebrow">1 · 테마 고르기</p>
        <div class="theme-grid">${S.themes.map(themeCard).join('')}</div>
      </section>
      <aside class="side">
        ${t ? enterPanel(t, name) : `<div class="panel"><p class="eyebrow">2 · 이름 적고 입장</p><p class="muted small" style="margin-top:8px">테마를 고르면 새 방을 만들 수 있어요.</p></div>`}
        <div class="panel">
          <form id="f-code" class="enter">
            <div class="enter-head"><p class="eyebrow">초대받았나요?</p><h3>방 코드로 들어가기</h3></div>
            <label class="field"><span>방 코드</span>
              <input class="input" id="in-code" name="code" maxlength="4" autocomplete="off" value="${esc(S.inviteCode)}" placeholder="예: K7QF" style="text-transform:uppercase;font-family:var(--f-mono);letter-spacing:.15em" required></label>
            <label class="field"><span>내 이름</span>
              <input class="input" id="in-name-code" name="name" maxlength="16" value="${esc(name)}" required></label>
            <button class="btn" type="submit">입장</button>
          </form>
        </div>
      </aside>
    </div>
  </div>`;
}

function themeCard(t, i) {
  const n = t.players.min === t.players.max ? `${t.players.max}명` : `${t.players.min}–${t.players.max}명`;
  const cards = (t.cards?.length || Object.values(t.variants || {}).some((v) => v.cards?.length)) ? '단서 카드' : '카드 없음';
  const tags = [n, `진행 약 ${totalMinutes(t)}분`, cards, t.rounds.some((r) => r.talk) ? '밀담' : '', t.lock ? '암호 필요' : ''].filter(Boolean);
  const faces = themePortraits(t).slice(0, 7);
  return `<button type="button" class="theme-card ${S.selTheme === t.id ? 'sel' : ''}" style="--tilt:${[-1.2, 0.8, -0.5, 1][i % 4]}deg" data-act="pick-theme" data-id="${t.id}">
    <span class="theme-no">${esc(themeLabel(t))}</span>
    <span class="theme-title">${esc(t.title)}</span>
    ${t.subtitle ? `<span class="theme-sub">${esc(t.subtitle)}</span>` : ''}
    ${faces.length ? `<span class="theme-faces">${faces.map((f, k) => `<img src="${esc(imgUrl(f, t))}" alt="" style="--k:${k}" loading="lazy">`).join('')}</span>` : ''}
    <span class="theme-meta">${tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</span>
  </button>`;
}

function enterPanel(t, name) {
  const now = S.store.now();
  const open = Object.entries(S.lobby)
    .filter(([, r]) => r && r.theme === t.id && r.phase === 'select' && now - (r.createdAt || 0) < ROOM_TTL)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  const variants = t.variants ? Object.entries(t.variants) : [];
  return `<div class="panel enter">
    <div class="enter-head">
      <p class="eyebrow">2 · 이름 적고 입장</p>
      <h3>${esc(t.title)}</h3>
      ${t.summary ? `<p class="muted small">${esc(t.summary)}</p>` : ''}
      ${t.credit ? `<p class="muted small">${esc(t.credit)}</p>` : ''}
    </div>
    <form id="f-create">
      <label class="field"><span>내 이름</span><input class="input" id="in-name" name="name" maxlength="16" value="${esc(name)}" required></label>
      ${variants.length ? `<label class="field"><span>인원</span><select class="input" id="in-variant" name="variant">${variants.map(([k, v]) => `<option value="${esc(k)}" ${k === variants[variants.length - 1][0] ? 'selected' : ''}>${esc(v.label || k)}</option>`).join('')}</select></label>` : ''}
      ${t.lock ? `<label class="field"><span>테마 암호 (방을 만들 때만 필요해요)</span><input class="input" id="in-pw" name="pw" type="password" autocomplete="off" value="${esc(lGet(`mm:pw:${t.id}`) || lGet('mm:pw') || '')}"></label>` : ''}
      <button class="btn" type="submit">새 방 만들고 입장</button>
    </form>
    ${isPeer() ? '<p class="small muted">방을 만들면 방 코드가 생겨요. 친구들은 \'방 코드로 들어가기\'나 초대 링크로 들어와요.</p>' : `<div class="room-list">
      <p class="small muted">${open.length ? '이 테마로 열려 있는 방 · 위에 이름을 적고 들어가세요' : '이 테마로 열려 있는 방이 아직 없어요.'}</p>
      ${open.map(([code, r]) => `<div class="room-row">
        <span><span class="room-code">${esc(code)}</span> <span class="muted small">${r.count || 0}명 모임</span></span>
        <button class="btn ghost sm" type="button" data-act="join-open" data-code="${esc(code)}">들어가기</button>
      </div>`).join('')}
    </div>`}
  </div>`;
}

function renderRoom() {
  const t = S.theme;
  const m = meta();
  const body = m.phase === 'select' ? selectView() : m.phase === 'play' ? playView() : m.phase === 'vote' ? voteView() : endView();
  $('#view').innerHTML = `<div class="room">
    <div class="roombar">
      <button class="btn ghost sm" data-act="leave">${m.phase === 'select' ? '방 나가기' : '홈으로'}</button>
      <div class="roombar-title"><span class="theme-no">${esc(themeLabel(t))}${t.label && t.no ? ` · ${esc(t.label)}` : ''}</span><strong>${esc(t.title)}</strong></div>
      ${t.relations ? '<button class="btn ghost sm" data-act="relations">관계도</button>' : ''}
      <button class="code-chip" data-act="copy-link" title="초대 링크 복사">방 ${esc(S.code)} · 링크 복사</button>
    </div>
    ${S.conn === 'lost' ? '<p class="conn-lost">방장과 연결이 끊겼어요. 다시 연결하는 중이에요… 방장이 창을 닫았다면 다시 열 때까지 기다려 주세요.</p>' : ''}
    ${isServerHost() ? '<p class="host-note">내가 방장이에요. 이 창이 게임을 진행하니 끝날 때까지 닫지 마세요. 새로고침은 괜찮아요.</p>' : ''}
    ${seatsStrip()}
    ${body}
  </div>`;
  queueMicrotask(() => {
    document.querySelectorAll('.mcard.deal').forEach((el) => S.dealt.add(el.dataset.id));
  });
}

// 테이블에 앉은 사람들
function seatsStrip() {
  const m = meta();
  const badge = (p) => {
    if (m.phase === 'select') return p.agree === m.selVer ? '<span class="seat-badge ok">동의</span>' : '';
    if (m.phase === 'play') return p.skip === m.round ? '<span class="seat-badge">건너뜀</span>' : '';
    if (m.phase === 'vote') return !p.gm && p.vote ? '<span class="seat-badge ok">투표함</span>' : '';
    return '';
  };
  return `<div class="seats">${players().map((p) => {
    const c = charOf(p.char);
    return `<div class="seat ${p.id === S.pid ? 'me' : ''} ${p.online ? '' : 'off'}" title="${esc(who(p.id))}">
      <span class="seat-ava">${avatar(p.id, 'lg')}${p.id === hostId() ? '<span class="crown" title="방장">방장</span>' : ''}</span>
      <span class="seat-name">${esc(p.name)}</span>
      <span class="seat-char">${p.gm ? '진행자' : esc(c?.name || '고르는 중')}</span>
      ${badge(p)}
    </div>`;
  }).join('')}</div>`;
}

/* 캐릭터 선택 */
function selectView() {
  const t = S.theme;
  const m = meta();
  const mine = me();
  const ps = players();
  const act = actors();
  const holders = {};
  act.forEach((p) => { if (p.char) (holders[p.char] ||= []).push(p); });
  const agreed = ps.filter((p) => p.agree === m.selVer).length;
  const iAgree = mine.agree === m.selVer;
  const problems = [];
  if (!act.length) problems.push('플레이어가 한 명은 있어야 해요.');
  if (act.some((p) => !p.char)) problems.push('아직 캐릭터를 고르지 않은 사람이 있어요.');
  if (Object.values(holders).some((a) => a.length > 1)) problems.push('같은 캐릭터를 고른 사람이 있어요.');
  if (act.length > t.characters.length) problems.push(`캐릭터는 ${t.characters.length}명인데 플레이어가 ${act.length}명이에요. 남는 사람은 진행자로 참가해 주세요.`);
  const short = act.length < t.players.min ? `이 테마는 ${t.players.min}명이 하는 걸 권장해요. 지금 ${act.length}명이라 남는 캐릭터는 아무도 맡지 않게 돼요.` : '';
  const publicDocs = (t.docs || []).filter((d) => d.show === 'always');

  return `
  <section class="phase-head">
    <p class="eyebrow">캐릭터 선택</p>
    <h2>누구를 맡을까요?</h2>
    <p class="desc">캐릭터를 눌러 고르세요. 모두 고른 뒤 전원이 '동의'를 누르면 게임이 시작돼요. 누가 캐릭터를 바꾸면 동의는 처음부터 다시 받아요.</p>
    <div class="btn-row">
      <button class="btn ${iAgree ? 'on' : ''}" data-act="agree" ${problems.length && !iAgree ? 'disabled' : ''}>${iAgree ? '동의함 · 취소' : '동의'} <span class="small">${agreed}/${ps.length}</span></button>
      <button class="btn ghost" data-act="random">전체 랜덤</button>
      ${t.allowGM ? `<button class="btn ghost" data-act="toggle-gm">${mine.gm ? '플레이어로 참가' : '진행자(GM)로 참가'}</button>` : ''}
      ${isPdf(t) ? publicDocs.map((d) => `<button class="btn ghost" data-act="doc" data-file="d:${esc(d.id)}">${esc(d.title)}</button>`).join('') : '<button class="btn ghost" data-act="intro">사건 개요</button>'}
    </div>
    ${problems.map((x) => `<p class="warn">${esc(x)}</p>`).join('')}
    ${short ? `<p class="muted small">${esc(short)}</p>` : ''}
    ${t.lang && t.lang !== 'ko' ? '<p class="muted small">자료는 일본어 원본이에요. 자료 창의 \'번역 도움\'으로 한국어로 볼 수 있어요.</p>' : ''}
  </section>
  <div class="select-layout">
    <div class="char-grid">${t.characters.map((c) => charCard(c, holders[c.id] || [])).join('')}</div>
    <aside class="side">
      ${t.howto ? `<div class="panel"><h3>이 테마 진행 방법</h3><p class="small muted" style="white-space:pre-wrap">${esc(t.howto)}</p></div>` : ''}
      ${logPanel()}
    </aside>
  </div>`;
}

function charCard(c, holders) {
  const mine = holders.some((p) => p.id === S.pid);
  const cls = [mine ? 'mine' : '', holders.length && !mine ? 'taken' : '', holders.length > 1 ? 'clash' : ''].join(' ');
  return `<div class="char-card ${cls}">
    <button type="button" class="char-pick" data-act="pick-char" data-id="${c.id}" aria-label="${esc(c.name)} 고르기">
      <span class="char-photo">${c.img ? `<img src="${esc(imgUrl(c.img))}" alt="" loading="lazy">` : `<span class="glyph">${esc(c.name.slice(0, 1))}</span>`}</span>
      <span class="char-text">
        <span class="name">${esc(c.name)}</span>
        <span class="sub">${esc(c.sub || '')}</span>
        <span class="note">${esc(c.note || '')}</span>
      </span>
    </button>
    <span class="char-foot">
      ${holders.length ? `<span class="who">${holders.map((p) => esc(p.name)).join(', ')}</span>` : '<span class="who empty">비어 있음</span>'}
      ${c.cover ? `<button class="btn ghost sm" data-act="doc" data-file="v:${c.id}">표지</button>` : ''}
    </span>
  </div>`;
}

/* 진행 중 */
function stepsBar(current) {
  const t = S.theme;
  const names = [...t.rounds.map((r) => r.name), '투표', '결과'];
  return `<ol class="steps">${names.map((n, i) => `<li class="${i < current ? 'done' : i === current ? 'now' : ''}">${esc(n)}</li>`).join('')}</ol>`;
}

const CIRC = 2 * Math.PI * 52;
function timerState() {
  const m = meta();
  const total = (S.theme.rounds[m.round]?.minutes || 1) * 60000;
  const left = (m.roundEndsAt || 0) - S.store.now();
  if (left <= 0 && held()) return { text: `+${fmtTime(-left)}`, cls: 'over', frac: 1 };
  return { text: fmtTime(Math.max(0, left)), cls: left < 60000 ? 'low' : '', frac: Math.max(0, Math.min(1, left / total)) };
}

function playView() {
  const t = S.theme;
  const m = meta();
  const r = t.rounds[m.round] || {};
  const ps = players();
  const skipped = ps.filter((p) => p.skip === m.round).length;
  const iSkip = me().skip === m.round;
  const hold = held();
  const hostName = S.room.players?.[hostId()]?.name || '방장';
  const ts = timerState();
  return `
  <section class="round-head">
    ${stepsBar(m.round)}
    <div class="round-now">
      <p class="eyebrow">${m.round + 1} / ${t.rounds.length} 단계${r.talk ? ' · <span class="talk-on">밀담 가능</span>' : ''}</p>
      <h2>${esc(r.name)}</h2>
      ${r.note ? `<p class="desc">${esc(r.note)}</p>` : ''}
    </div>
    <div class="timer-box">
      <div class="clock ${ts.cls}">
        <svg viewBox="0 0 120 120" aria-hidden="true"><circle class="clock-bg" cx="60" cy="60" r="52"></circle>
          <circle id="clock-arc" class="clock-arc" cx="60" cy="60" r="52" stroke-dasharray="${CIRC.toFixed(1)}" stroke-dashoffset="${(CIRC * (1 - ts.frac)).toFixed(1)}"></circle></svg>
        <span id="timer" class="timer">${ts.text}</span>
      </div>
      ${hold ? `<span class="hold-note">연장 중 · ${isHost() ? '원할 때 다음 단계로 넘기세요' : `${esc(hostName)}님이 넘길 때까지 계속돼요`}</span>` : ''}
      <div class="btn-row">
        <button class="btn ${iSkip ? 'on' : 'ghost'}" data-act="skip">${iSkip ? '건너뛰기 취소' : '건너뛰기'} <span class="small">${skipped}/${ps.length}</span></button>
        ${isHost() ? `<button class="btn ghost" data-act="hold">${hold ? '연장 취소' : '연장'}</button>` : ''}
        ${isHost() && hold ? '<button class="btn" data-act="next-step">다음 단계로</button>' : ''}
      </div>
    </div>
  </section>
  <div class="play-layout">
    <div class="play-main">
      ${docsPanel()}
      ${t.cards?.length ? tableView() + handView() : ''}
    </div>
    <aside class="side">${placesPanel()}${t.cards?.length ? sharedPanel() : ''}${logPanel()}</aside>
  </div>`;
}

function docTile(key, title, sub, mine, from) {
  if (!canOpen(key)) {
    return `<button class="doc-btn locked" disabled><strong>${esc(title)}</strong><span>${from != null ? `${from + 1}단계에 열려요` : '아직 볼 수 없어요'}</span></button>`;
  }
  return `<button class="doc-btn ${mine ? 'key' : ''}" data-act="doc" data-file="${esc(key)}"><strong>${esc(title)}</strong><span>${esc(sub)}</span></button>`;
}

function docsPanel() {
  const t = S.theme;
  const c = charOf(me().char);
  const mine = [];
  const shared = [];
  if (isPdf(t)) {
    if (c) (c.docs || []).forEach((d, i) => mine.push(docTile(`c:${c.id}:${i}`, d.title, `${c.name} · 나만 볼 수 있어요`, true, d.from || 0)));
    (t.docs || []).forEach((d) => {
      if (d.show === 'end') return;
      if (d.show === 'gm' && !isGM()) return;
      shared.push(docTile(`d:${d.id}`, d.title, d.show === 'gm' ? '진행자만' : '모두 공개', false, d.from));
    });
    t.characters.forEach((ch) => { if (ch.cover) shared.push(docTile(`v:${ch.id}`, `${ch.name} 표지`, '모두 공개', false)); });
    if (isGM()) t.characters.forEach((ch) => (ch.docs || []).forEach((d, i) => shared.push(docTile(`c:${ch.id}:${i}`, `${ch.name} · ${d.title}`, '진행자', false))));
  } else {
    if (c) mine.push(`<button class="doc-btn key" data-act="sheet" data-id="${c.id}"><strong>내 캐릭터</strong><span>${esc(c.name)} · 나만 볼 수 있어요</span></button>`);
    shared.push('<button class="doc-btn" data-act="intro"><strong>사건 개요</strong><span>모두 공개</span></button>');
    if (isGM()) t.characters.forEach((ch) => shared.push(`<button class="doc-btn" data-act="sheet" data-id="${ch.id}"><strong>${esc(ch.name)}</strong><span>캐릭터 시트</span></button>`));
  }
  return `<section class="docs-wrap">
    ${mine.length ? `<div><p class="eyebrow">내 자료</p><div class="docs">${mine.join('')}</div></div>` : ''}
    <div><p class="eyebrow">공용 자료</p><div class="docs">${shared.join('')}</div></div>
  </section>`;
}

function picksLeft() {
  const r = S.theme.rounds[roundNo()] || {};
  if (r.pick == null) return Infinity;
  const used = Object.values(S.room?.cards || {}).filter((c) => c.takenBy === S.pid && c.takenRound === roundNo()).length;
  return Math.max(0, r.pick - used);
}

function pickText() {
  const r = S.theme.rounds[roundNo()] || {};
  if (isGM()) return '진행자는 카드를 가져가지 않아요.';
  if (r.pick === 0) return '이번 단계에는 카드를 가져갈 수 없어요.';
  if (r.pick == null) return '카드를 원하는 만큼 가져갈 수 있어요.';
  return `이번 단계에 1인당 ${r.pick}장 · 나는 ${picksLeft()}장 더 가져갈 수 있어요.`;
}

function tableView() {
  const t = S.theme;
  const visible = t.cards.filter((c) => (c.round ?? 0) <= roundNo());
  const locs = (t.locations || [])
    .map((l) => ({ ...l, cards: visible.filter((c) => c.location === l.id) }))
    .filter((l) => l.cards.length);
  let n = 0;
  return `<section class="table">
    <div class="table-head"><h3>조사 테이블</h3><p class="small muted">${esc(pickText())}</p></div>
    <div class="locs">${locs.map((l) => `<div class="loc"><h4>${esc(l.name)}</h4><div class="loc-cards">${l.cards.map((c) => tableCard(c, n++)).join('')}</div></div>`).join('') || '<p class="muted">아직 펼쳐진 카드가 없어요. 단계가 진행되면 이곳에 카드가 펼쳐져요.</p>'}</div>
  </section>`;
}

function tableCard(c, i) {
  const st = cardState(c.id);
  const rot = tilt(c.id, 4);
  const deal = S.dealt.has(c.id) ? '' : 'deal';
  if (!st.owner) {
    const can = phase() === 'play' && picksLeft() > 0 && !isGM();
    const armed = S.armed === c.id;
    const attrs = can ? `role="button" tabindex="0" data-act="arm"` : '';
    return `<div class="mcard back ${armed ? 'armed' : ''} ${can ? '' : 'locked'} ${deal}" data-id="${c.id}" style="--rot:${rot}deg;--d:${i * 90}ms" ${attrs} aria-label="${esc(c.back || cardTag(c))} 카드, 뒷면">
      <span class="mcard-label">${c.back ? `<span class="mcard-back">${esc(c.back)}</span>` : `<span class="mcard-loc">${esc(locName(c.location))}</span><span class="mcard-no">${cardNo(c)}</span>`}</span>
      ${armed ? `<button class="btn sm take-btn" data-act="take" data-id="${c.id}">가져가기</button>` : ''}
    </div>`;
  }
  if (st.public) return faceCard(c, '공개', deal);
  return `<div class="mcard slot ${deal}" data-id="${c.id}" style="--rot:${rot}deg;--d:${i * 90}ms">${avatar(st.owner)}<span>${esc(st.owner === S.pid ? '내가' : who(st.owner))}<br>가져감</span></div>`;
}

function faceCard(c, badge = '', extra = '') {
  return `<div class="mcard face ${extra}" data-id="${c.id}" style="--rot:${tilt(c.id, 3)}deg" role="button" tabindex="0" data-act="view-card">
    <span class="mcard-loc">${esc(c.file ? locName(c.location) : cardTag(c))}</span>
    <span class="mcard-title">${esc(c.title)}</span>
    ${badge ? `<span class="pub">${esc(badge)}</span>` : ''}
  </div>`;
}

function handView() {
  const mine = S.theme.cards.filter((c) => cardState(c.id).owner === S.pid);
  return `<section class="hand">
    <h3>내 카드 ${mine.length}장</h3>
    <div class="hand-fan">${mine.length
      ? mine.map((c) => faceCard(c, cardState(c.id).public ? '공개함' : '', S.arrived === c.id ? 'arrive' : '')).join('')
      : '<p class="muted small">아직 가져온 카드가 없어요. 테이블의 카드를 눌러 가져오세요.</p>'}</div>
  </section>`;
}

function cardList(list) {
  if (!list.length) return '<p class="small muted">없음</p>';
  return `<ul class="card-list">${list.map((c) => `<li><button data-act="view-card" data-id="${c.id}">
    <strong>${esc(c.title)}</strong><span>${esc(cardTag(c))} · ${esc(who(cardState(c.id).owner))}</span>
  </button></li>`).join('')}</ul>`;
}

function sharedPanel() {
  const cards = S.theme.cards;
  const rules = cardRules();
  if (!rules.public && !rules.share) return '';
  const pub = cards.filter((c) => cardState(c.id).public);
  const toMe = cards.filter((c) => {
    const st = cardState(c.id);
    return !st.public && st.owner && st.owner !== S.pid && st.shared?.[S.pid];
  });
  return `<div class="panel">
    <h3>공개된 단서 ${pub.length}</h3>${cardList(pub)}
    <h3 style="margin-top:16px">나에게 보여준 카드 ${toMe.length}</h3>${cardList(toMe)}
  </div>`;
}

function placesPanel() {
  const t = S.theme;
  if (!t.rooms?.length) return '';
  const ps = players();
  const locOf = (p) => p.loc || t.rooms[0].id;
  return `<div class="panel"><h3>장소</h3><div class="places">${t.rooms.map((rm) => {
    const here = ps.filter((p) => locOf(p) === rm.id);
    const mineHere = locOf(me()) === rm.id;
    const full = rm.cap && here.length >= rm.cap;
    return `<div class="place ${mineHere ? 'here' : ''}">
      <div class="place-head"><strong>${esc(rm.name)}</strong><span class="small muted">${rm.cap ? `${here.length}/${rm.cap}명` : `${here.length}명`}</span></div>
      ${rm.note ? `<span class="small muted">${esc(rm.note)}</span>` : ''}
      ${here.length ? `<div class="chips">${here.map((p) => `<span class="chip">${avatar(p.id, 'xs')}${esc(p.name)}</span>`).join('')}</div>` : ''}
      ${mineHere ? '<span class="small" style="color:var(--brass)">지금 여기 있어요</span>'
        : `<button class="btn ghost sm" data-act="move" data-id="${rm.id}" ${full ? 'disabled' : ''}>${full ? '꽉 찼어요' : '여기로 이동'}</button>`}
    </div>`;
  }).join('')}</div></div>`;
}

function logPanel() {
  const items = Object.values(S.room?.log || {}).sort((a, b) => b.t - a.t).slice(0, 40);
  return `<details class="panel log-panel"><summary>기록 ${items.length ? `<span class="muted small">${items.length}</span>` : ''}</summary><ul class="log">${items.map((l) => `<li><time>${clock(l.t)}</time>${esc(l.m)}</li>`).join('') || '<li>아직 기록이 없어요.</li>'}</ul></details>`;
}

/* 투표와 결과 */
function voteView() {
  const t = S.theme;
  const v = t.vote || {};
  const m = meta();
  const act = actors();
  const mine = me();
  const voted = act.filter((p) => p.vote).length;
  const finalC = v.final ? charOf(v.final) : null;
  const rule = (finalC && holderOf(finalC.id) ? `${finalC.name}의 표가 최종 결정이 돼요.` : v.runoff ? '가장 많은 표를 받은 사람이 지목돼요. 동점이면 결선 투표를 해요.' : '가장 많은 표를 받은 쪽으로 결정돼요.')
    + (v.noSelf ? ' 자기 자신은 고를 수 없어요.' : '');
  const options = (m.runoff ? t.characters.filter((c) => m.runoff.includes(c.id)) : t.characters)
    .filter((c) => !(v.noSelf && c.id === mine.char));
  return `
  <section class="round-head">${stepsBar(t.rounds.length)}</section>
  <section class="phase-head">
    <p class="eyebrow">${m.runoff ? '결선 투표' : '최종 투표'} · ${voted}/${act.length}명 투표함</p>
    <h2>${m.runoff ? '동점이에요. 한 번 더!' : '범인은 누구일까요?'}</h2>
    <p class="desc">${mine.gm ? '진행자는 투표하지 않아요.' : '한 명을 고르세요. 모두 투표하기 전까지는 바꿀 수 있어요.'} ${esc(rule)}</p>
  </section>
  ${mine.gm ? '' : `<div class="vote-grid">
    ${options.map((c) => `<button class="vote-btn ${mine.vote === c.id ? 'mine' : ''}" data-act="vote" data-id="${c.id}">
      ${c.img ? `<img src="${esc(imgUrl(c.img))}" alt="" loading="lazy">` : ''}
      <span class="vote-text"><strong>${esc(c.name)}</strong><span>${esc(holderOf(c.id)?.name || '아무도 맡지 않음')}</span></span>
      ${mine.vote === c.id ? '<span class="stamp">지목</span>' : ''}</button>`).join('')}
    ${v.allowNone && !m.runoff ? `<button class="vote-btn none ${mine.vote === 'none' ? 'mine' : ''}" data-act="vote" data-id="none"><span class="vote-text"><strong>${esc(v.noneLabel || '범인 없음')}</strong><span>사건이 아니라고 봐요</span></span>${mine.vote === 'none' ? '<span class="stamp">선택</span>' : ''}</button>` : ''}
  </div>`}
  <div class="play-layout">
    <div class="play-main">${docsPanel()}</div>
    <aside class="side">${logPanel()}</aside>
  </div>`;
}

function verdict() {
  const t = S.theme;
  const v = t.vote || {};
  const act = actors();
  const label = (id) => (id === 'none' ? v.noneLabel || '범인 없음' : charOf(id)?.name || '알 수 없음');
  const tally = {};
  act.forEach((p) => { if (p.vote) tally[p.vote] = (tally[p.vote] || 0) + 1; });
  const finalP = v.final ? act.find((p) => p.char === v.final && p.vote) : null;
  if (finalP) return { id: finalP.vote, text: label(finalP.vote), how: `${charOf(v.final).name}의 표로 결정`, label, tally };
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((k) => tally[k] === max);
  if (top.length === 1) return { id: top[0], text: label(top[0]), how: `최다 득표 ${max}표`, label, tally, top };
  return { id: null, text: (top.length > 1 && v.tieText) || '결정하지 못했어요', how: top.length ? `동점: ${top.map(label).join(', ')}` : '투표 없음', label, tally, top };
}

function endView() {
  const t = S.theme;
  const act = actors();
  const vd = verdict();
  const vc = vd.id && charOf(vd.id);
  const truth = t.culprit ? charOf(t.culprit) : null;
  const docs = isPdf(t) ? [
    ...(t.docs || []).filter((d) => d.show === 'end' || d.show === 'gm').map((d) => docTile(`d:${d.id}`, d.title, '이제 볼 수 있어요', d.id === 'ending' || d.id === 'epilogue')),
    ...(t.docs || []).filter((d) => d.show !== 'end' && d.show !== 'gm').map((d) => docTile(`d:${d.id}`, d.title, '모두 공개', false)),
    ...t.characters.flatMap((c) => (c.docs || []).map((d, i) => docTile(`c:${c.id}:${i}`, `${c.name} · ${d.title}`, '핸드아웃', false))),
    ...t.characters.flatMap((c) => (c.endDocs || []).map((d, i) => docTile(`e:${c.id}:${i}`, `${c.name} · ${d.title}`, me().char === c.id ? '내 기념 카드' : '기념 카드', me().char === c.id))),
  ].join('') : '';
  return `
  <section class="round-head">${stepsBar(t.rounds.length + 1)}</section>
  <section class="verdict-box">
    ${vc?.img ? `<span class="verdict-photo"><img src="${esc(imgUrl(vc.img))}" alt=""><span class="stamp big">지목</span></span>` : ''}
    <div>
      <p class="eyebrow">결과 · 여러분이 지목한 쪽은</p>
      <p class="verdict">${esc(vd.text)}</p>
      <p class="small muted">${esc(vd.how)}${vc && holderOf(vc.id) ? ` · ${esc(holderOf(vc.id).name)}님` : ''}</p>
      ${t.endNote ? `<p class="desc" style="margin-top:10px">${esc(t.endNote)}</p>` : ''}
    </div>
  </section>
  <div class="play-layout">
    <div class="play-main result">
      <div class="tbl-wrap"><table class="votes"><thead><tr><th>플레이어</th><th>캐릭터</th><th>투표</th></tr></thead>
        <tbody>${act.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(charOf(p.char)?.name || '')}</td><td>${esc(p.vote ? vd.label(p.vote) : '-')}</td></tr>`).join('')}</tbody></table></div>
      ${isPdf(t) ? `<div><p class="eyebrow">모든 자료</p><div class="docs">${docs}</div></div>` : `
        <div class="panel"><p class="eyebrow">진상</p><h3 style="margin:6px 0 12px">진범은 ${esc(truth?.name || '?')}</h3><p class="story">${esc(t.solution || '')}</p></div>
        <div class="panel"><p class="eyebrow">모두의 비밀</p>${t.characters.map((c) => `<div style="margin-top:14px"><h4>${esc(c.name)}</h4><p class="story small">${esc(c.secret || '')}</p></div>`).join('')}</div>
        ${t.cards?.length ? `<section class="table"><div class="table-head"><h3>모든 단서</h3></div><div class="loc-cards">${t.cards.map((c) => faceCard(c)).join('')}</div></section>` : ''}`}
      <div class="btn-row"><button class="btn ghost" data-act="leave">홈으로</button></div>
    </div>
    <aside class="side">${logPanel()}</aside>
  </div>`;
}

/* ---------- 관계도 ---------- */
function relationsSVG() {
  const t = S.theme;
  const R = t.relations;
  if (!R) return '';
  const W = R.width || 1000;
  const nodes = new Map();
  const person = (id) => {
    const c = charOf(id);
    const p = (R.people || []).find((x) => x.id === id) || {};
    return { id, name: p.name || c?.name || id, sub: p.sub || c?.sub || '', note: p.note ?? c?.note ?? '', img: p.img || c?.img || '', place: !!p.place, victim: !!p.victim, isChar: !!c, x: p.x, y: p.y };
  };
  let lines = '';
  let labels = '';
  const tag = (x, y, text, cls = '') => {
    const w = [...text].length * 17 + 22;
    return `<g class="rel-tag ${cls}"><rect x="${x - w / 2}" y="${y - 17}" width="${w}" height="34" rx="17"></rect><text x="${x}" y="${y + 6}">${esc(text)}</text></g>`;
  };
  if (R.tree) {
    const parents = R.tree.parents.map(person);
    const kids = R.tree.children.filter((id) => charOf(id)).map(person);
    const gap = W / kids.length;
    kids.forEach((k, i) => { k.x = gap * (i + 0.5); k.y = 470; });
    parents.forEach((p, i) => { p.x = W / 2 + (i === 0 ? -190 : 190); p.y = 110; });
    [...parents, ...kids].forEach((n) => nodes.set(n.id, n));
    const busY = 330;
    lines += `<path class="rel-line" d="M${parents[0].x} 110 H${parents[1].x} M${W / 2} 110 V${busY} M${kids[0].x} ${busY} H${kids[kids.length - 1].x} ${kids.map((k) => `M${k.x} ${busY} V${k.y - 60}`).join(' ')}"></path>`;
    if (R.tree.parentsLabel) labels += tag(W / 2, 110, R.tree.parentsLabel);
    labels += tag(W / 2, busY, '자녀');
  } else {
    (R.people || []).forEach((p) => nodes.set(p.id, person(p.id)));
    (R.groups || []).forEach((g) => {
      lines += `<rect class="rel-group" x="${g.x}" y="${g.y}" width="${g.w}" height="${g.h}" rx="22"></rect><text class="rel-group-label" x="${g.x + 22}" y="${g.y + 34}">${esc(g.label)}</text>`;
    });
    (R.links || []).forEach((l) => {
      const a = nodes.get(l.a);
      const b = nodes.get(l.b);
      if (!a || !b) return;
      const at = l.at ?? 0.5;
      lines += `<line class="rel-line" x1="${a.x}" y1="${a.y}" x2="${b.x}" y2="${b.y}"></line>`;
      if (l.label) labels += tag(a.x + (b.x - a.x) * at, a.y + (b.y - a.y) * at, l.label);
    });
  }
  const all = [...nodes.values()];
  const H = Math.max(...all.map((n) => n.y)) + 170;
  const nodeSvg = all.map((n, i) => {
    const holder = n.isChar ? holderOf(n.id) : null;
    const r = 56;
    const shape = n.place
      ? `<rect class="rel-place" x="${n.x - r}" y="${n.y - r * 0.7}" width="${r * 2}" height="${r * 1.4}" rx="14"></rect><text class="rel-place-text" x="${n.x}" y="${n.y + 9}">${esc(n.name)}</text>`
      : `<clipPath id="rc${i}"><circle cx="${n.x}" cy="${n.y}" r="${r}"></circle></clipPath>
         <circle class="rel-ring ${n.victim ? 'victim' : ''} ${holder?.id === S.pid ? 'mine' : ''}" cx="${n.x}" cy="${n.y}" r="${r + 5}"></circle>
         ${n.img ? `<image href="${esc(imgUrl(n.img))}" x="${n.x - r}" y="${n.y - r}" width="${r * 2}" height="${r * 2}" clip-path="url(#rc${i})" preserveAspectRatio="xMidYMid slice"></image>` : `<circle cx="${n.x}" cy="${n.y}" r="${r}" class="rel-blank"></circle>`}`;
    const nameY = n.place ? n.y + r * 0.7 + 30 : n.y + r + 34;
    return `<g class="rel-node"><title>${esc([n.name, n.sub, n.note].filter(Boolean).join(' · '))}</title>${shape}
      ${n.place ? '' : `<text class="rel-name" x="${n.x}" y="${nameY}">${esc(n.name)}</text>`}
      <text class="rel-sub" x="${n.x}" y="${nameY + (n.place ? 0 : 26)}">${esc(n.place ? n.sub : n.sub)}</text>
      ${n.isChar ? `<text class="rel-player ${holder ? '' : 'none'}" x="${n.x}" y="${nameY + (n.place ? 26 : 52)}">${esc(holder ? `플레이어: ${holder.name}` : '아무도 맡지 않음')}</text>` : ''}
      ${!n.isChar && n.note ? `<text class="rel-note" x="${n.x}" y="${nameY + 52}">${esc(n.note)}</text>` : ''}
    </g>`;
  }).join('');
  return `<svg class="rel-svg" viewBox="-60 0 ${W + 120} ${H}" role="img" aria-label="${esc(t.title)} 캐릭터 관계도">${lines}${labels}${nodeSvg}</svg>`;
}

/* ---------- 모달 ---------- */
function openModal(m) {
  S.modal = { ...m, fresh: true };
  S.modalSig = null;
  renderModal();
}
function closeModal() { S.modal = null; renderModal(); }

function renderModal() {
  const wrap = $('#modal');
  const box = $('#modal .modal-box');
  if (!S.modal || S.view !== 'room') {
    wrap.hidden = true;
    box.innerHTML = '';
    S.modalSig = null;
    return;
  }
  const sig = JSON.stringify([S.modal.type, S.modal.id, S.modal.mode, S.modal.type === 'card' ? cardState(S.modal.id) : null, players().map((p) => [p.id, p.name, p.char])]);
  if (sig === S.modalSig) return;
  S.modalSig = sig;
  wrap.hidden = false;
  box.classList.toggle('wide', S.modal.type === 'relations');
  if (S.modal.type === 'card') box.innerHTML = cardModal();
  else if (S.modal.type === 'sheet') box.innerHTML = sheetModal(S.modal.id);
  else if (S.modal.type === 'intro') box.innerHTML = introModal();
  else if (S.modal.type === 'relations') box.innerHTML = `<div class="modal-head"><div><p class="eyebrow">모두 공개된 정보만 담았어요</p><h3>캐릭터 관계도</h3></div>${closeBtn}</div><div class="rel-wrap">${relationsSVG()}</div>`;
  S.modal.fresh = false;
}

const closeBtn = '<button class="btn ghost sm" data-act="close-modal">닫기</button>';

function cardModal() {
  const id = S.modal.id;
  const c = cardOf(id);
  const st = cardState(id);
  const mine = st.owner === S.pid;
  const rules = cardRules();
  const others = players().filter((p) => p.id !== S.pid && !p.gm);
  const sharedNames = Object.keys(st.shared || {}).filter((k) => st.shared[k]).map(who);
  const status = st.public ? '전체 공개된 카드예요.'
    : mine ? (sharedNames.length ? `보여준 사람: ${sharedNames.join(', ')}` : '아직 아무에게도 보여주지 않았어요.')
      : st.owner ? `${who(st.owner)}님의 카드예요.` : '';
  const live = ['play', 'vote'].includes(phase());
  let actions = '';
  if (mine && live) {
    if (S.modal.mode === 'share') {
      const cand = others.filter((p) => !st.shared?.[p.id]);
      actions = `<form id="f-share" class="sheet">
        <p class="small muted">보여줄 사람을 고르세요. 한 번 보여준 카드는 되돌릴 수 없어요.</p>
        <div class="checks">${cand.map((p) => `<label><input type="checkbox" name="to" value="${p.id}"> ${avatar(p.id, 'xs')} ${esc(who(p.id))}</label>`).join('') || '<p class="small muted">더 보여줄 사람이 없어요.</p>'}</div>
        <div class="btn-row"><button class="btn" type="submit" ${cand.length ? '' : 'disabled'}>보여주기</button><button class="btn ghost" type="button" data-act="card-mode">취소</button></div>
      </form>`;
    } else if (S.modal.mode === 'give') {
      actions = `<form id="f-give" class="sheet">
        <p class="small muted">누구에게 넘겨줄까요?</p>
        <div class="checks">${others.map((p) => `<label><input type="radio" name="to" value="${p.id}" required> ${avatar(p.id, 'xs')} ${esc(who(p.id))}</label>`).join('')}</div>
        <p class="warn">넘겨주면 이 카드는 더 이상 볼 수 없어요.</p>
        <div class="btn-row"><button class="btn" type="submit">넘겨주기</button><button class="btn ghost" type="button" data-act="card-mode">취소</button></div>
      </form>`;
    } else if (rules.public || rules.share || rules.give) {
      actions = `<div class="btn-row">
        ${rules.public ? `<button class="btn" data-act="card-public" ${st.public ? 'disabled' : ''}>전체 공개</button>` : ''}
        ${rules.share ? `<button class="btn ghost" data-act="card-mode" data-mode="share" ${st.public ? 'disabled' : ''}>몇 명에게만 보여주기</button>` : ''}
        ${rules.give ? `<button class="btn ghost" data-act="card-mode" data-mode="give" ${others.length ? '' : 'disabled'}>넘겨주기</button>` : ''}
      </div>`;
    }
    if (rules.note) actions += `<p class="small muted">${esc(rules.note)}</p>`;
  }
  return `<div class="modal-head"><p class="eyebrow">${c.file ? '수색 시트' : '단서 카드'}</p>${closeBtn}</div>
    <article class="paper-card" style="${S.modal.fresh ? '' : 'animation:none'}">
      <span class="mcard-loc">${esc(locName(c.location))}${c.back && c.file ? ` · ${esc(c.back)}` : ''}</span>
      <h3>${esc(c.title)}</h3>
      ${c.text ? `<div class="body">${esc(c.text)}</div>` : ''}
      ${c.file ? `<button class="btn" data-act="doc" data-file="k:${esc(c.id)}">시트 열기</button>` : ''}
    </article>
    <p class="small muted">${esc(status)}</p>
    ${actions}`;
}

function sheetModal(charId) {
  const c = charOf(charId);
  const allowed = me().char === charId || isGM() || phase() === 'end';
  if (!c || !allowed) return `<div class="modal-head"><h3>볼 수 없어요</h3>${closeBtn}</div>`;
  const sec = (title, body) => (body ? `<section><h4>${title}</h4><div class="body">${esc(body)}</div></section>` : '');
  return `<div class="modal-head"><div class="sheet-id">${c.img ? `<img src="${esc(imgUrl(c.img))}" alt="">` : ''}<div><p class="eyebrow">캐릭터 시트 · 비공개</p><h3>${esc(c.name)} <span class="muted small">${esc(c.sub || '')}</span></h3></div></div>${closeBtn}</div>
    <div class="sheet">
      ${sec('모두가 아는 모습', c.public)}
      ${sec('나만 아는 비밀', c.secret)}
      ${sec('목표', c.goal)}
      ${c.timeline?.length ? `<section><h4>그날 밤의 행적</h4><ul>${c.timeline.map((x) => `<li>${esc(x)}</li>`).join('')}</ul></section>` : ''}
    </div>`;
}

function introModal() {
  const t = S.theme;
  return `<div class="modal-head"><div><p class="eyebrow">사건 개요 · 모두 공개</p><h3>${esc(t.title)}</h3></div>${closeBtn}</div>
    <div class="sheet">
      <div class="body">${esc(t.intro || t.summary || '')}</div>
      <section><h4>등장인물</h4>${t.characters.map((c) => `<p class="intro-char">${c.img ? `<img src="${esc(imgUrl(c.img))}" alt="">` : ''}<span><strong>${esc(c.name)}</strong> <span class="muted small">${esc(c.sub || '')}</span><br><span class="small">${esc(c.public || c.note || '')}</span></span></p>`).join('')}</section>
    </div>`;
}

/* ---------- 밀담 ---------- */
const hasTalk = () => !!S.theme?.rounds.some((r) => r.talk);
const talkOpen = () => phase() === 'play' && !!S.theme.rounds[roundNo()]?.talk;
const talkMax = () => S.theme.talkMax || 3;
const msgsOf = (th) => Object.entries(th?.msgs || {}).map(([k, m]) => ({ k, ...m })).sort((a, b) => a.t - b.t);
const lastT = (th) => { const ms = msgsOf(th); return ms.length ? ms[ms.length - 1].t : th.t || 0; };
const myThreads = () => Object.entries(S.room?.chats || {})
  .filter(([, th]) => th?.members?.[S.pid])
  .map(([id, th]) => ({ id, ...th }))
  .sort((a, b) => lastT(b) - lastT(a));
const readKey = () => `mm:read:${S.code}:${S.pid}`;
const readMap = () => safe(() => JSON.parse(lGet(readKey()))) || {};
const unreadOf = (th) => { const r = readMap()[th.id] || 0; return msgsOf(th).filter((m) => m.p !== S.pid && m.t > r).length; };
function markRead(th) {
  const map = readMap();
  map[th.id] = lastT(th);
  lSet(readKey(), JSON.stringify(map));
}
const memberNames = (th) => Object.keys(th.members || {}).filter((id) => id !== S.pid).map(who).join(', ');

function renderChat() {
  const fab = $('#chat-fab');
  const box = $('#chat');
  const show = S.view === 'room' && hasTalk() && phase() !== 'select';
  fab.hidden = !show || S.chat.open;
  box.hidden = !show || !S.chat.open;
  if (!show) return;
  const threads = myThreads();
  const unread = threads.reduce((s, th) => s + unreadOf(th), 0);
  const badge = fab.querySelector('.badge');
  badge.textContent = unread;
  badge.hidden = !unread;
  fab.classList.toggle('live', talkOpen());
  if (unread > S.chat.unread && !S.chat.open) toast('밀담 메시지가 왔어요.');
  S.chat.unread = unread;
  if (!S.chat.open) return;

  const th = S.chat.tid ? threads.find((x) => x.id === S.chat.tid) : null;
  if (S.chat.view === 'thread' && !th) S.chat.view = 'list';
  const sig = JSON.stringify([S.chat.view, S.chat.tid, S.chat.picks, talkOpen(), S.chat.view === 'thread' ? th : threads.map((x) => [x.id, lastT(x), unreadOf(x)]), players().map((p) => [p.id, p.name, p.char])]);
  if (sig === S.chat.sig) return;
  S.chat.sig = sig;

  const head = $('.chat-head', box);
  const body = $('.chat-body', box);
  const form = $('#f-chat');
  const close = '<button class="btn ghost sm" data-act="chat-close" aria-label="밀담 닫기">닫기</button>';
  const back = '<button class="btn ghost sm" data-act="chat-view" data-view="list">목록</button>';
  form.hidden = S.chat.view !== 'thread';

  if (S.chat.view === 'list') {
    head.innerHTML = `<strong>밀담</strong>${close}`;
    body.innerHTML = `
      <p class="chat-note">${talkOpen() ? `최대 ${talkMax()}명까지 따로 이야기할 수 있어요. 대화에 없는 사람에게는 보이지 않아요.` : '지금은 밀담 단계가 아니에요. 지난 대화는 볼 수 있어요.'}</p>
      <button class="btn sm" data-act="chat-view" data-view="new" ${talkOpen() ? '' : 'disabled'}>새 밀담</button>
      <ul class="thread-list">${threads.map((x) => {
        const last = msgsOf(x).pop();
        const n = unreadOf(x);
        return `<li><button data-act="chat-open" data-id="${esc(x.id)}">
          <span class="ava-stack">${Object.keys(x.members).filter((id) => id !== S.pid).map((id) => avatar(id, 'sm')).join('')}</span>
          <span class="thread-text"><strong>${esc(memberNames(x))}</strong><span>${esc(last ? `${last.p === S.pid ? '나: ' : ''}${last.m}` : '아직 메시지가 없어요')}</span></span>
          ${n ? `<span class="badge">${n}</span>` : ''}
        </button></li>`;
      }).join('') || '<li class="muted small">아직 밀담이 없어요.</li>'}</ul>`;
  } else if (S.chat.view === 'new') {
    const others = players().filter((p) => p.id !== S.pid);
    const full = S.chat.picks.length >= talkMax() - 1;
    head.innerHTML = `${back}<strong>누구와 이야기할까요?</strong>`;
    body.innerHTML = `
      <p class="chat-note">나를 포함해 최대 ${talkMax()}명 · ${talkMax() - 1}명까지 고를 수 있어요.</p>
      <div class="pick-list">${others.map((p) => {
        const on = S.chat.picks.includes(p.id);
        return `<button class="pick ${on ? 'on' : ''}" data-act="chat-pick" data-id="${p.id}" ${!on && full ? 'disabled' : ''}>${avatar(p.id, 'sm')}<span>${esc(who(p.id))}</span></button>`;
      }).join('')}</div>
      <button class="btn" data-act="chat-start" ${S.chat.picks.length ? '' : 'disabled'}>밀담 시작</button>`;
  } else {
    head.innerHTML = `${back}<span class="ava-stack">${Object.keys(th.members).filter((id) => id !== S.pid).map((id) => avatar(id, 'sm')).join('')}</span><strong class="thread-title">${esc(memberNames(th))}</strong>`;
    const ms = msgsOf(th);
    body.innerHTML = ms.length ? ms.map((m) => `<div class="msg ${m.p === S.pid ? 'mine' : ''}">
        ${m.p === S.pid ? '' : avatar(m.p, 'sm')}
        <div class="bubble">${m.p === S.pid ? '' : `<span class="msg-who">${esc(who(m.p))}</span>`}${esc(m.m)}<time>${clock(m.t)}</time></div>
      </div>`).join('') : '<p class="chat-note">첫 메시지를 보내 보세요.</p>';
    body.scrollTop = body.scrollHeight;
    markRead(th);
    const input = $('#chat-input');
    input.disabled = !talkOpen();
    input.placeholder = talkOpen() ? '메시지 입력' : '지금은 밀담 단계가 아니에요';
    $('#f-chat button').disabled = !talkOpen();
  }
}

async function startChat() {
  if (!talkOpen()) throw new Error('지금은 밀담 단계가 아니에요.');
  const ids = [S.pid, ...S.chat.picks].sort();
  if (ids.length > talkMax()) throw new Error(`밀담은 최대 ${talkMax()}명까지예요.`);
  const tid = `t-${ids.join('-')}`;
  if (!S.room?.chats?.[tid]) {
    await S.store.set(roomPath(`chats/${tid}`), { members: Object.fromEntries(ids.map((id) => [id, true])), by: S.pid, t: S.store.now() });
  }
  Object.assign(S.chat, { view: 'thread', tid, picks: [], sig: null });
  renderChat();
  $('#chat-input')?.focus();
}

async function sendChat(text) {
  const m = text.trim().slice(0, 500);
  if (!m) return;
  if (!talkOpen()) throw new Error('지금은 밀담 단계가 아니에요.');
  const input = $('#chat-input');
  input.value = '';
  await S.store.push(roomPath(`chats/${S.chat.tid}/msgs`), { p: S.pid, t: S.store.now(), m });
}

/* ---------- 연출 ---------- */
let curtainTimer;
function curtain(kicker, title, sub = '', img = '') {
  const el = $('#curtain');
  $('.curtain-kicker', el).textContent = kicker;
  $('.curtain-title', el).textContent = title;
  $('.curtain-sub', el).textContent = sub;
  const pic = $('.curtain-img', el);
  pic.hidden = !img;
  if (img) pic.src = img;
  el.hidden = false;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(curtainTimer);
  curtainTimer = setTimeout(() => { el.hidden = true; el.classList.remove('show'); }, img ? 3600 : 2300);
}

function announce(m) {
  const { phase: ph, round, runoff } = S.seen;
  S.seen = { phase: m.phase, round: m.round, runoff: !!m.runoff };
  if (m.phase === 'vote' && m.runoff && !runoff) {
    curtain('결선 투표', '동점이에요. 한 번 더!', m.runoff.map((id) => charOf(id)?.name).join(' · '));
    return;
  }
  if (ph === m.phase && round === m.round) return;
  const t = S.theme;
  if (m.phase === 'play') {
    const r = t.rounds[m.round];
    curtain(ph === 'select' ? '게임 시작' : `${m.round + 1}단계`, r?.name || '', r?.talk ? '밀담할 수 있어요' : '');
  } else if (m.phase === 'vote') {
    curtain('최종 투표', '범인은 누구일까요?');
  } else if (m.phase === 'end') {
    const vd = verdict();
    const c = vd.id && charOf(vd.id);
    curtain('지목된 사람은…', vd.text, vd.how, c?.img ? imgUrl(c.img) : '');
  }
}

/* ---------- PDF·이미지 자료 ---------- */
function docInfo(key) {
  const t = S.theme;
  const [kind, a, b] = key.split(':');
  if (kind === 'd') { const d = t.docs?.find((x) => x.id === a); return d?.file ? { path: d.file, title: d.title } : null; }
  if (kind === 'k') { const c = cardOf(a); return c?.file ? { path: c.file, title: `수색 시트 · ${c.title}` } : null; }
  const c = charOf(a);
  if (!c) return null;
  if (kind === 'v') return c.cover ? { path: c.cover, title: `${c.name} 표지` } : null;
  if (kind === 'c') { const d = c.docs?.[+b]; return d?.file ? { path: d.file, title: `${c.name} · ${d.title}` } : null; }
  if (kind === 'e') { const d = c.endDocs?.[+b]; return d?.file ? { path: d.file, title: `${c.name} · ${d.title}` } : null; }
  return null;
}

function canOpen(key) {
  const [kind, a, b] = key.split(':');
  const end = phase() === 'end';
  const started = phase() !== 'select';
  if (kind === 'd') {
    const d = S.theme.docs?.find((x) => x.id === a);
    if (!d) return false;
    if (d.show === 'always') return true;
    if (d.show === 'play') return reached(d.from || 0) || (isGM() && started);
    if (d.show === 'gm') return end || (isGM() && started);
    return end;
  }
  if (kind === 'v') return true;
  if (kind === 'c') {
    const d = charOf(a)?.docs?.[+b];
    return !!d && (end || (isGM() && started) || (me().char === a && reached(d.from || 0)));
  }
  if (kind === 'e') return end;
  if (kind === 'k') return canSee(a);
  return false;
}

async function loadFile(path) {
  if (S.files.has(path)) return S.files.get(path);
  const res = await fetch(S.theme.base + path);
  if (!res.ok) throw new Error(`파일을 찾을 수 없어요 (${res.status})`);
  let buf = await res.arrayBuffer();
  if (S.theme.lock) {
    if (!S.key) throw new Error('이 방에 테마 암호가 없어요.');
    buf = await Lock.decrypt(S.key, buf);
  }
  S.files.set(path, buf);
  return buf;
}

const sniff = (buf) => {
  const u = new Uint8Array(buf, 0, 4);
  if (u[0] === 0xff && u[1] === 0xd8) return 'jpg';
  if (u[0] === 0x89 && u[1] === 0x50) return 'png';
  return 'pdf';
};
const mimeOf = (kind) => ({ pdf: 'application/pdf', jpg: 'image/jpeg', png: 'image/png' }[kind]);

async function openDoc(key) {
  if (!canOpen(key)) throw new Error('지금은 볼 수 없는 자료예요.');
  const d = docInfo(key);
  if (!d) throw new Error('자료 파일이 없어요.');
  Object.assign(S.doc, { file: d.path, title: d.title, bytes: null });
  $('#docpane').hidden = false;
  $('.docpane-title').textContent = d.title;
  $('.docpane-help').hidden = !(S.theme.lang && S.theme.lang !== 'ko');
  const pages = $('.docpane-pages');
  pages.innerHTML = '<p class="docpane-msg">자료를 여는 중…</p>';
  try {
    const bytes = await loadFile(d.path);
    if (S.doc.file !== d.path) return;
    S.doc.bytes = bytes;
    S.doc.kind = sniff(bytes);
    await drawDoc();
  } catch (e) {
    pages.innerHTML = `<p class="docpane-msg">자료를 열지 못했어요. (${esc(e.message)})</p>`;
  }
}

async function drawDoc() {
  $('.docpane-zoom').textContent = `${Math.round(S.doc.zoom * 100)}%`;
  if (!S.doc.bytes) return;
  const host = $('.docpane-pages');
  if (S.doc.kind === 'pdf') { await renderPdf(host, S.doc.bytes, S.doc.zoom); return; }
  const url = URL.createObjectURL(new Blob([S.doc.bytes], { type: mimeOf(S.doc.kind) }));
  host.replaceChildren();
  const img = document.createElement('img');
  img.src = url;
  img.alt = S.doc.title;
  img.style.width = `${Math.min(900, host.clientWidth - 2) * S.doc.zoom}px`;
  host.appendChild(img);
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

async function saveDocImage() {
  if (!S.doc.bytes) return;
  const base = S.doc.title.replace(/[\\/:*?"<>|]/g, '_');
  if (S.doc.kind !== 'pdf') { downloadBlob(new Blob([S.doc.bytes], { type: mimeOf(S.doc.kind) }), `${base}.${S.doc.kind}`); return; }
  const canvases = [...document.querySelectorAll('.docpane-pages canvas')];
  for (const [i, c] of canvases.entries()) {
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    downloadBlob(blob, canvases.length > 1 ? `${base}-${i + 1}.png` : `${base}.png`);
  }
  toast('이미지를 저장했어요. 구글 번역(이미지)이나 파파고 사진 번역에 넣어 보세요.');
}

function closeDoc() {
  $('#docpane').hidden = true;
  $('.docpane-pages').replaceChildren();
  Object.assign(S.doc, { file: null, bytes: null });
}

/* ---------- 들어가기 / 나가기 ---------- */
const newPlayer = (name, now, t) => ({
  name, joinedAt: now, char: null, gm: false, agree: 0, skip: -1, vote: null, online: true, loc: t.rooms?.[0]?.id || null,
});

async function createRoom(base, name, pw, variant) {
  if (!base) throw new Error('테마를 먼저 골라 주세요.');
  if (!name) throw new Error('이름을 적어 주세요.');
  const t = resolveTheme(base, variant);
  let keyB64 = null;
  if (base.lock) {
    if (!pw) throw new Error('이 테마는 암호가 있어야 방을 만들 수 있어요.');
    const key = await Lock.keyFromPassword(pw, base.lock);
    if (!(await Lock.keyMatches(key, base.lock))) throw new Error('테마 암호가 맞지 않아요.');
    keyB64 = await Lock.exportKey(key);
    lSet(`mm:pw:${base.id}`, pw);
    lSet('mm:pw', pw);
  }
  let code = null;
  for (let i = 0; i < 6 && !code; i++) {
    const c = newCode();
    const r = await S.store.open(c, 'host', { fresh: true });
    if (!r.ok) {
      if (r.reason === 'unavailable-id') continue;
      throw new Error('연결 서버에 접속하지 못했어요. 인터넷 연결을 확인하고 다시 시도해 주세요.');
    }
    if (await S.store.get(`rooms/${c}/meta`)) { S.store.close(); continue; }
    code = c;
  }
  if (!code) throw new Error('방 코드를 만들지 못했어요. 다시 시도해 주세요.');
  const pid = newId();
  const now = S.store.now();
  await S.store.set(`rooms/${code}`, {
    meta: { theme: base.id, variant: t.variant || null, createdAt: now, phase: 'select', round: 0, roundEndsAt: 0, selVer: 1, key: keyB64, host: pid },
    players: { [pid]: newPlayer(name, now, t) },
  });
  await S.store.set(`lobby/${code}`, { theme: base.id, createdAt: now, phase: 'select', count: 1 });
  await S.store.push(`rooms/${code}/log`, { t: now, m: `${name}님이 방을 만들었어요.` });
  lSet('mm:name', name);
  await enterRoom(code, pid);
}

async function joinRoom(code, name, as = 'join') {
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('방 코드는 4자리예요.');
  if (!name) throw new Error('이름을 적어 주세요.');
  const r = await S.store.open(code, as);
  if (!r.ok) {
    throw new Error(as === 'host'
      ? '방을 다시 열지 못했어요. 잠시 뒤 다시 시도해 주세요.'
      : '방을 찾을 수 없어요. 코드가 맞는지, 방장이 사이트를 열어 두었는지 확인해 주세요.');
  }
  try {
    await joinOpened(code, name);
  } catch (e) {
    S.store.close();
    throw e;
  }
}

async function joinOpened(code, name) {
  const room = await S.store.get(`rooms/${code}`);
  if (!room?.meta) throw new Error('그 코드의 방을 찾을 수 없어요.');
  const base = S.byId[room.meta.theme];
  if (!base) throw new Error('이 사이트에 없는 테마의 방이에요.');
  const t = resolveTheme(base, room.meta.variant);
  lSet('mm:name', name);
  const found = Object.entries(room.players || {}).find(([, p]) => p?.name === name);
  let pid;
  if (found) {
    pid = found[0];
  } else {
    if (room.meta.phase !== 'select') throw new Error('이미 시작한 방이에요. 처음 들어올 때 쓴 이름으로만 다시 들어갈 수 있어요.');
    pid = newId();
    const now = S.store.now();
    await S.store.set(`rooms/${code}/players/${pid}`, newPlayer(name, now, t));
    await S.store.update(`lobby/${code}`, { count: Object.keys(room.players || {}).length + 1 });
    await S.store.push(`rooms/${code}/log`, { t: now, m: `${name}님이 들어왔어요.` });
  }
  if (!(await enterRoom(code, pid))) throw new Error('방에 들어가지 못했어요. 다시 시도해 주세요.');
}

async function enterRoom(code, pid) {
  const room = await S.store.get(`rooms/${code}`);
  const base = room?.meta && S.byId[room.meta.theme];
  if (!base || !room.players?.[pid]?.name) { sSet('mm:cur', null); return false; }
  S.unsub?.();
  S.cancelDisc?.();
  const t = resolveTheme(base, room.meta.variant);
  Object.assign(S, { code, pid, theme: t, room, view: 'room', armed: null, modal: null, conn: 'ok' });
  S.seen = { phase: room.meta.phase, round: room.meta.round };
  S.dealt = new Set();
  Object.assign(S.chat, { open: false, view: 'list', tid: null, picks: [], sig: null, unread: 0 });
  S.key = room.meta.key ? await Lock.importKey(room.meta.key) : null;
  S.files.clear();
  S.store.identify(pid);
  sSet('mm:cur', JSON.stringify({ code, pid, role: S.store.role }));
  lSet('mm:last', JSON.stringify({ code, name: room.players[pid].name, title: t.title, role: S.store.role }));
  history.replaceState(null, '', `?room=${code}`);
  S.unsub = S.store.listen(`rooms/${code}`, onRoom);
  await S.store.update(`rooms/${code}/players/${pid}`, { online: true });
  S.cancelDisc = S.store.onDisconnect(`rooms/${code}/players/${pid}`, { online: false });
  render();
  return true;
}

function leaveView(msg) {
  S.unsub?.();
  S.unsub = null;
  S.cancelDisc?.();
  S.cancelDisc = null;
  Object.assign(S, { view: 'home', room: null, code: null, pid: null, theme: null, key: null, modal: null, armed: null, conn: 'ok' });
  S.chat.open = false;
  S.store.close();
  closeDoc();
  sSet('mm:cur', null);
  history.replaceState(null, '', location.pathname);
  if (msg) toast(msg);
  render();
}

async function leave() {
  const m = meta();
  const serverHost = isServerHost();
  if (m.phase !== 'select') {
    if (serverHost && !confirm('방장이 나가면 친구들 연결이 끊겨요. 나중에 같은 이름으로 다시 들어오면 이어서 할 수 있어요. 나갈까요?')) return;
    leaveView();
    return;
  }
  if (!confirm(serverHost ? '방장이 나가면 방이 닫혀요. 나갈까요?' : '방에서 나갈까요? 고른 캐릭터는 풀려요.')) return;
  const name = me().name;
  const code = S.code;
  const ps = players();
  const ver = (m.selVer || 0) + 1;
  const pid = S.pid;
  const nextHost = hostId() === pid ? ps.find((p) => p.id !== pid)?.id : hostId();
  S.unsub?.();
  S.unsub = null;
  S.cancelDisc?.();
  S.cancelDisc = null;
  lSet('mm:last', null);
  try {
    if (ps.length <= 1 || serverHost) {
      await S.store.remove(`rooms/${code}`);
      await S.store.remove(`lobby/${code}`);
    } else {
      await S.store.update(`rooms/${code}`, { [`players/${pid}`]: null, 'meta/selVer': ver, 'meta/host': nextHost });
      await S.store.update(`lobby/${code}`, { count: ps.length - 1 });
      await S.store.push(`rooms/${code}/log`, { t: S.store.now(), m: `${name}님이 나갔어요.` });
    }
  } finally {
    leaveView();
  }
}

function onRoom(v) {
  if (S.view !== 'room') return;
  if (!v?.meta) { leaveView('방이 닫혔어요.'); return; }
  S.room = v;
  if (!v.players?.[S.pid]?.name) { leaveView('방에서 나왔어요.'); return; }
  if (v.meta.key && !S.key) Lock.importKey(v.meta.key).then((k) => { S.key = k; });
  if (S.modal?.type === 'card' && !canSee(S.modal.id)) S.modal = null;
  if (S.armed && cardState(S.armed).owner) S.armed = null;
  announce(v.meta);
  render();
  checkFlow();
}

/* ---------- 행동 ---------- */
async function pickChar(id) {
  const m = meta();
  const mine = me();
  if (m.phase !== 'select') return;
  if (mine.gm) throw new Error('진행자는 캐릭터를 고르지 않아요. 플레이어로 바꾼 뒤 골라 주세요.');
  const other = actors().find((p) => p.char === id && p.id !== S.pid);
  if (other) throw new Error(`${other.name}님이 이미 골랐어요.`);
  await S.store.update(roomPath(), { [`players/${S.pid}/char`]: mine.char === id ? null : id, 'meta/selVer': (m.selVer || 0) + 1 });
}

async function randomAll() {
  const act = actors();
  const chars = shuffle(S.theme.characters.map((c) => c.id));
  if (!act.length) throw new Error('캐릭터를 맡을 플레이어가 없어요.');
  if (act.length > chars.length) throw new Error('플레이어가 캐릭터보다 많아요. 남는 사람은 진행자로 참가해 주세요.');
  const up = { 'meta/selVer': (meta().selVer || 0) + 1 };
  act.forEach((p, i) => { up[`players/${p.id}/char`] = chars[i]; });
  await S.store.update(roomPath(), up);
  await log(`${me().name}님이 캐릭터를 전체 랜덤으로 정했어요. 모두 다시 동의해 주세요.`);
}

async function toggleGM() {
  const gm = !me().gm;
  await S.store.update(roomPath(), { [`players/${S.pid}/gm`]: gm, [`players/${S.pid}/char`]: null, 'meta/selVer': (meta().selVer || 0) + 1 });
  await log(`${me().name}님이 ${gm ? '진행자(GM)로' : '플레이어로'} 참가해요.`);
}

async function agree() {
  const m = meta();
  await S.store.update(roomPath(`players/${S.pid}`), { agree: me().agree === m.selVer ? 0 : m.selVer });
}

async function skip() {
  const m = meta();
  if (m.phase !== 'play') return;
  await S.store.update(roomPath(`players/${S.pid}`), { skip: me().skip === m.round ? -1 : m.round });
}

async function toggleHold() {
  const m = meta();
  if (m.phase !== 'play' || !isHost()) return;
  const on = !held();
  await S.store.update(roomPath('meta'), { hold: on ? m.round : null });
  await log(on ? `방장이 '${S.theme.rounds[m.round].name}' 단계를 연장했어요. 방장이 넘길 때까지 계속돼요.` : '방장이 연장을 취소했어요.');
}

async function nextStep() {
  if (meta().phase !== 'play' || !isHost()) return;
  await advance(meta().round, 'host');
}

async function move(roomId) {
  const t = S.theme;
  const rm = t.rooms.find((r) => r.id === roomId);
  const here = players().filter((p) => p.id !== S.pid && (p.loc || t.rooms[0].id) === roomId);
  if (rm.cap && here.length >= rm.cap) throw new Error(`${rm.name}은(는) 꽉 찼어요.`);
  await S.store.update(roomPath(`players/${S.pid}`), { loc: roomId });
  await log(`${who(S.pid)}님이 ${rm.name}(으)로 이동했어요.`);
}

async function take(id) {
  const m = meta();
  if (m.phase !== 'play') return;
  if (isGM()) throw new Error('진행자는 카드를 가져가지 않아요.');
  if (picksLeft() <= 0) throw new Error('이번 단계에 가져갈 수 있는 카드를 다 가져왔어요.');
  const res = await S.store.transaction(roomPath(`cards/${id}`), (cur) => {
    if (cur && cur.owner) return undefined;
    return { owner: S.pid, takenBy: S.pid, takenRound: m.round, public: false };
  });
  S.armed = null;
  if (!res.committed) { render(); throw new Error('다른 사람이 먼저 가져갔어요.'); }
  S.arrived = id;
  setTimeout(() => { S.arrived = null; }, 900);
  await log(`${who(S.pid)}님이 ${cardOf(id).back || cardTag(cardOf(id))} 카드를 가져갔어요.`);
  openModal({ type: 'card', id });
}

async function makePublic(id) {
  if (cardState(id).owner !== S.pid || !cardRules().public) return;
  await S.store.update(roomPath(`cards/${id}`), { public: true });
  await log(`${who(S.pid)}님이 '${cardOf(id).title}' 카드를 전체 공개했어요.`);
}

async function shareCard(id, pids) {
  if (cardState(id).owner !== S.pid || !cardRules().share) return;
  if (!pids.length) throw new Error('보여줄 사람을 골라 주세요.');
  const up = {};
  pids.forEach((p) => { up[`shared/${p}`] = true; });
  await S.store.update(roomPath(`cards/${id}`), up);
  S.modal.mode = null;
  S.modalSig = null;
  renderModal();
  await log(`${who(S.pid)}님이 ${pids.map(who).join(', ')}님에게 ${cardTag(cardOf(id))} 카드를 보여줬어요.`);
}

async function giveCard(id, to) {
  if (cardState(id).owner !== S.pid || !cardRules().give) return;
  if (!to) throw new Error('넘겨줄 사람을 골라 주세요.');
  await S.store.update(roomPath(`cards/${id}`), { owner: to, [`shared/${to}`]: null });
  closeModal();
  await log(`${who(S.pid)}님이 ${cardTag(cardOf(id))} 카드를 ${who(to)}님에게 넘겼어요.`);
}

async function vote(id) {
  if (meta().phase !== 'vote' || isGM()) return;
  if (S.theme.vote?.noSelf && id === me().char) throw new Error('자기 자신에게는 투표할 수 없어요.');
  await S.store.update(roomPath(`players/${S.pid}`), { vote: me().vote === id ? null : id });
}

async function copyLink() {
  const url = `${location.origin}${location.pathname}?room=${S.code}`;
  try {
    await navigator.clipboard.writeText(url);
    toast('초대 링크를 복사했어요.');
  } catch {
    toast(url);
  }
}

/* ---------- 단계 넘기기 (조건을 본 사람이 시도, 트랜잭션으로 한 번만) ---------- */
function once(key, fn) {
  if (S.pending.has(key)) return;
  S.pending.add(key);
  Promise.resolve().then(fn).catch(console.error).finally(() => setTimeout(() => S.pending.delete(key), 1500));
}

function readyToStart() {
  const m = meta();
  const act = actors();
  if (!act.length || act.some((p) => !p.char)) return false;
  if (new Set(act.map((p) => p.char)).size !== act.length) return false;
  return players().every((p) => p.agree === m.selVer);
}

function checkFlow() {
  if (S.view !== 'room' || !S.room) return;
  if (isPeer() && !isServerHost()) return; // 방장 모드에서는 방장 창이 단계를 넘긴다
  const m = meta();
  if (m.phase === 'select' && readyToStart()) {
    once(`start:${m.selVer}`, () => startGame(m.selVer));
  } else if (m.phase === 'play') {
    const ps = players();
    const timeUp = (m.roundEndsAt || 0) <= S.store.now() && !held();
    const allSkip = ps.length > 0 && ps.every((p) => p.skip === m.round);
    if (timeUp || allSkip) once(`round:${m.round}`, () => advance(m.round, allSkip ? 'skip' : 'time'));
  } else if (m.phase === 'vote') {
    const act = actors();
    if (act.length && act.every((p) => p.vote)) once(`end:${m.runoffCount || 0}`, finishVote);
  }
}

async function startGame(selVer) {
  const t = S.theme;
  const res = await S.store.transaction(roomPath('meta'), (m) => {
    if (!m || m.phase !== 'select' || m.selVer !== selVer) return undefined;
    return { ...m, phase: 'play', round: 0, roundEndsAt: S.store.now() + t.rounds[0].minutes * 60000 };
  });
  if (!res.committed) return;
  await S.store.update(`lobby/${S.code}`, { phase: 'play' });
  await log('모두 동의해서 게임을 시작했어요.');
}

async function advance(from, reason) {
  const t = S.theme;
  const res = await S.store.transaction(roomPath('meta'), (m) => {
    if (!m || m.phase !== 'play' || m.round !== from) return undefined;
    const next = from + 1;
    if (next < t.rounds.length) return { ...m, round: next, roundEndsAt: S.store.now() + t.rounds[next].minutes * 60000 };
    return { ...m, phase: 'vote', round: next, roundEndsAt: 0 };
  });
  if (!res.committed) return;
  const why = { skip: '모두 건너뛰어서', time: '시간이 다 돼서', host: '방장이 넘겨서' }[reason];
  const nm = res.value;
  await log(nm.phase === 'vote' ? `${why} 최종 투표로 넘어갔어요.` : `${why} '${t.rounds[nm.round].name}' 단계로 넘어갔어요.`);
}

async function finishVote() {
  const m = meta();
  const vd = verdict();
  // 동점이면 한 번 결선 투표
  if (S.theme.vote?.runoff && !vd.id && vd.top?.length > 1 && !(m.runoffCount > 0) && vd.top.every((id) => id !== 'none')) {
    const up = { 'meta/runoff': vd.top, 'meta/runoffCount': 1 };
    actors().forEach((p) => { up[`players/${p.id}/vote`] = null; });
    await S.store.update(roomPath(), up);
    await log(`동점이라 ${vd.top.map((id) => charOf(id)?.name).join(', ')} 중에서 결선 투표를 해요.`);
    return;
  }
  const res = await S.store.transaction(roomPath('meta'), (mm) => {
    if (!mm || mm.phase !== 'vote') return undefined;
    return { ...mm, phase: 'end' };
  });
  if (!res.committed) return;
  await S.store.update(`lobby/${S.code}`, { phase: 'end' });
  await log('모두 투표해서 결과가 공개됐어요.');
}

function tick() {
  if (S.view !== 'room' || !S.room) return;
  if (meta().phase === 'play') {
    const ts = timerState();
    const el = $('#timer');
    if (el) {
      el.textContent = ts.text;
      el.closest('.clock').className = `clock ${ts.cls}`;
      $('#clock-arc')?.setAttribute('stroke-dashoffset', (CIRC * (1 - ts.frac)).toFixed(1));
    }
  }
  checkFlow();
}

/* ---------- 이벤트 ---------- */
function onClick(e) {
  const el = e.target.closest('[data-act]');
  if (!el || el.disabled) return;
  const { act, id } = el.dataset;
  switch (act) {
    case 'pick-theme':
      S.selTheme = id;
      render();
      $('#in-name')?.focus();
      break;
    case 'join-open':
      busy(joinRoom(el.dataset.code, ($('#in-name')?.value || '').trim()));
      break;
    case 'resume':
      busy(joinRoom(el.dataset.code, el.dataset.name, el.dataset.role === 'host' ? 'host' : 'join'));
      break;
    case 'leave': busy(leave()); break;
    case 'copy-link': copyLink(); break;
    case 'relations': openModal({ type: 'relations' }); break;
    case 'pick-char': busy(pickChar(id)); break;
    case 'random': busy(randomAll()); break;
    case 'toggle-gm': busy(toggleGM()); break;
    case 'agree': busy(agree()); break;
    case 'skip': busy(skip()); break;
    case 'hold': busy(toggleHold()); break;
    case 'next-step': busy(nextStep()); break;
    case 'move': busy(move(id)); break;
    case 'arm': {
      const cid = el.dataset.id;
      S.armed = S.armed === cid ? null : cid;
      render();
      break;
    }
    case 'take': busy(take(id)); break;
    case 'view-card': openModal({ type: 'card', id: el.dataset.id }); break;
    case 'card-mode':
      S.modal.mode = el.dataset.mode || null;
      S.modalSig = null;
      renderModal();
      break;
    case 'card-public': busy(makePublic(S.modal.id)); break;
    case 'sheet': openModal({ type: 'sheet', id }); break;
    case 'intro': openModal({ type: 'intro' }); break;
    case 'close-modal': closeModal(); break;
    case 'vote': busy(vote(id)); break;
    case 'doc': busy(openDoc(el.dataset.file)); break;
    case 'doc-zoom':
      S.doc.zoom = Math.min(3, Math.max(0.5, S.doc.zoom + 0.25 * Number(el.dataset.z)));
      busy(drawDoc());
      break;
    case 'doc-tab':
      if (S.doc.bytes) window.open(URL.createObjectURL(new Blob([S.doc.bytes], { type: mimeOf(S.doc.kind) })), '_blank');
      break;
    case 'doc-save': busy(saveDocImage()); break;
    case 'doc-close': closeDoc(); break;
    case 'chat-toggle':
      S.chat.open = true;
      S.chat.sig = null;
      renderChat();
      break;
    case 'chat-close':
      S.chat.open = false;
      renderChat();
      break;
    case 'chat-view':
      Object.assign(S.chat, { view: el.dataset.view, picks: el.dataset.view === 'new' ? [] : S.chat.picks, sig: null });
      renderChat();
      break;
    case 'chat-open':
      Object.assign(S.chat, { view: 'thread', tid: id, sig: null });
      renderChat();
      break;
    case 'chat-pick': {
      const i = S.chat.picks.indexOf(id);
      if (i >= 0) S.chat.picks.splice(i, 1);
      else if (S.chat.picks.length < talkMax() - 1) S.chat.picks.push(id);
      S.chat.sig = null;
      renderChat();
      break;
    }
    case 'chat-start': busy(startChat()); break;
    default: break;
  }
}

function onChange() { /* 선택 상자는 제출할 때 읽는다 */ }

function onSubmit(e) {
  const f = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f));
  if (f.id === 'f-create') busy(createRoom(S.byId[S.selTheme], (data.name || '').trim(), data.pw || '', data.variant));
  else if (f.id === 'f-code') busy(joinRoom((data.code || '').trim().toUpperCase(), (data.name || '').trim()));
  else if (f.id === 'f-share') busy(shareCard(S.modal.id, new FormData(f).getAll('to')));
  else if (f.id === 'f-give') busy(giveCard(S.modal.id, data.to));
  else if (f.id === 'f-chat') busy(sendChat(data.msg || ''));
}

function onKey(e) {
  if (e.key === 'Escape') {
    if (!$('#docpane').hidden) closeDoc();
    else if (S.modal) closeModal();
    else if (S.chat.open) { S.chat.open = false; renderChat(); }
    return;
  }
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute?.('role') === 'button' && el.dataset.act) {
    e.preventDefault();
    el.click();
  }
}

boot();
