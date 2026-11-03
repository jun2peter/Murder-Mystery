import { createStore } from './store.js';
import * as Lock from './locked.js';
import { renderPdf } from './pdfview.js';

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const ROOM_TTL = 12 * 3600 * 1000;

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
  modal: null,
  modalSig: null,
  doc: { file: null, title: '', zoom: 1, bytes: null },
  files: new Map(),
  pending: new Set(),
  seen: { phase: null, round: null },
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
// 남은 시간. 연장 중에 시간이 지나면 초과 시간을 +로 센다.
function timerState() {
  const left = (meta().roundEndsAt || 0) - S.store.now();
  if (left <= 0 && held()) return { text: `+${fmtTime(-left)}`, cls: 'over' };
  return { text: fmtTime(Math.max(0, left)), cls: left < 60000 ? 'low' : '' };
}
const timerText = () => timerState().text;
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

/* ---------- 방 상태 읽기 ---------- */
const roomPath = (p = '') => `rooms/${S.code}${p ? `/${p}` : ''}`;
const meta = () => S.room?.meta || {};
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
const isPdf = (t) => t.kind === 'pdf';
const themeLabel = (t) => (t.no ? `테마 ${t.no}` : t.label || '샘플');
const totalMinutes = (t) => t.rounds.reduce((s, r) => s + (r.minutes || 0), 0);
const cardOf = (id) => S.theme.cards.find((c) => c.id === id);
const cardState = (id) => S.room?.cards?.[id] || {};
const locName = (id) => S.theme.locations?.find((l) => l.id === id)?.name || id;
const cardNo = (c) => String(S.theme.cards.filter((x) => x.location === c.location).indexOf(c) + 1).padStart(2, '0');
const cardTag = (c) => `${locName(c.location)} ${cardNo(c)}`;
const canSee = (id) => {
  const st = cardState(id);
  return st.owner === S.pid || st.public || !!st.shared?.[S.pid] || isGM() || meta().phase === 'end';
};
const log = (m) => S.store.push(roomPath('log'), { t: S.store.now(), m });

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
  S.store.listen('lobby', (v) => { S.lobby = v || {}; if (S.view === 'home') render(); });

  document.addEventListener('click', onClick);
  document.addEventListener('submit', onSubmit);
  document.addEventListener('keydown', onKey);
  setInterval(tick, 1000);

  const q = (new URLSearchParams(location.search).get('room') || '').toUpperCase();
  const cur = safe(() => JSON.parse(sGet('mm:cur')));
  if (cur?.code && (!q || q === cur.code) && (await enterRoom(cur.code, cur.pid))) return;
  S.inviteCode = q;
  render();
}

/* ---------- 그리기 ---------- */
function render() {
  const view = $('#view');
  const keep = {};
  view.querySelectorAll('input[id]').forEach((i) => { if (i.type !== 'checkbox' && i.type !== 'radio') keep[i.id] = i.value; });
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
      <p class="lede">테마를 고르고 이름을 적은 뒤 같은 방에 모이세요. 캐릭터는 모두가 동의해야 확정되고, 단서 카드는 테이블에 펼쳐 놓고 가져가요.</p>
    </header>
    ${S.store.mode === 'local' ? '<p class="notice"><strong>테스트 모드</strong> · 아직 Firebase를 연결하지 않아서 같은 브라우저의 탭끼리만 연결돼요. 친구들과 하려면 README의 Firebase 설정을 마쳐 주세요.</p>' : ''}
    ${last ? `<p class="notice">최근에 있던 방 <strong>${esc(last.code)}</strong> · ${esc(last.title || '')}
      <button class="btn ghost sm" data-act="resume" data-code="${esc(last.code)}" data-name="${esc(last.name)}">${esc(last.name)}(으)로 다시 들어가기</button></p>` : ''}
    <div class="home-cols">
      <section>
        <p class="eyebrow">1 · 테마 고르기</p>
        <div class="theme-grid">${S.themes.map(themeCard).join('')}</div>
      </section>
      <aside class="side">
        ${t ? enterPanel(t, name) : `<div class="panel"><p class="eyebrow">2 · 이름 적고 입장</p><p class="muted small" style="margin-top:8px">테마를 고르면 새 방을 만들거나, 그 테마로 열려 있는 방에 들어갈 수 있어요.</p></div>`}
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
  const tags = [n, `진행 약 ${totalMinutes(t)}분`, t.cards?.length ? `단서 카드 ${t.cards.length}장` : '카드 없음', t.lock ? '암호 필요' : ''].filter(Boolean);
  return `<button type="button" class="theme-card ${S.selTheme === t.id ? 'sel' : ''}" style="--tilt:${[-1.2, 0.8, -0.5, 1][i % 4]}deg" data-act="pick-theme" data-id="${t.id}">
    <span class="theme-no">${esc(themeLabel(t))}</span>
    <span class="theme-title">${esc(t.title)}</span>
    ${t.subtitle ? `<span class="theme-sub">${esc(t.subtitle)}</span>` : ''}
    <span class="theme-meta">${tags.map((x) => `<span class="tag">${esc(x)}</span>`).join('')}</span>
  </button>`;
}

function enterPanel(t, name) {
  const now = S.store.now();
  const open = Object.entries(S.lobby)
    .filter(([, r]) => r && r.theme === t.id && r.phase === 'select' && now - (r.createdAt || 0) < ROOM_TTL)
    .sort((a, b) => b[1].createdAt - a[1].createdAt);
  return `<div class="panel enter">
    <div class="enter-head">
      <p class="eyebrow">2 · 이름 적고 입장</p>
      <h3>${esc(t.title)}</h3>
      ${t.summary ? `<p class="muted small">${esc(t.summary)}</p>` : ''}
      ${t.credit ? `<p class="muted small">${esc(t.credit)}</p>` : ''}
    </div>
    <form id="f-create">
      <label class="field"><span>내 이름</span><input class="input" id="in-name" name="name" maxlength="16" value="${esc(name)}" required></label>
      ${t.lock ? `<label class="field"><span>테마 암호 (방을 만들 때만 필요해요)</span><input class="input" id="in-pw" name="pw" type="password" autocomplete="off" value="${esc(lGet(`mm:pw:${t.id}`) || '')}"></label>` : ''}
      <button class="btn" type="submit">새 방 만들고 입장</button>
    </form>
    <div class="room-list">
      <p class="small muted">${open.length ? '이 테마로 열려 있는 방 · 위에 이름을 적고 들어가세요' : '이 테마로 열려 있는 방이 아직 없어요.'}</p>
      ${open.map(([code, r]) => `<div class="room-row">
        <span><span class="room-code">${esc(code)}</span> <span class="muted small">${r.count || 0}명 모임</span></span>
        <button class="btn ghost sm" type="button" data-act="join-open" data-code="${esc(code)}">들어가기</button>
      </div>`).join('')}
    </div>
  </div>`;
}

function renderRoom() {
  const t = S.theme;
  const m = meta();
  const body = m.phase === 'select' ? selectView() : m.phase === 'play' ? playView() : m.phase === 'vote' ? voteView() : endView();
  $('#view').innerHTML = `<div class="room">
    <div class="roombar">
      <button class="btn ghost sm" data-act="leave">${m.phase === 'select' ? '방 나가기' : '홈으로'}</button>
      <div class="roombar-title"><span class="theme-no">${esc(themeLabel(t))}</span><strong>${esc(t.title)}</strong></div>
      <button class="code-chip" data-act="copy-link" title="초대 링크 복사">방 ${esc(S.code)} · 링크 복사</button>
    </div>
    ${body}
  </div>`;
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

  return `
  <section class="phase-head">
    <p class="eyebrow">캐릭터 선택</p>
    <h2>누구를 맡을까요?</h2>
    <p class="desc">캐릭터를 눌러 고르세요. 모두 고른 뒤 전원이 '동의'를 누르면 게임이 시작돼요. 누가 캐릭터를 바꾸면 동의는 처음부터 다시 받아요.</p>
    <div class="btn-row">
      <button class="btn ${iAgree ? 'on' : ''}" data-act="agree" ${problems.length && !iAgree ? 'disabled' : ''}>${iAgree ? '동의함 · 취소' : '동의'} <span class="small">${agreed}/${ps.length}</span></button>
      <button class="btn ghost" data-act="random">전체 랜덤</button>
      ${t.allowGM ? `<button class="btn ghost" data-act="toggle-gm">${mine.gm ? '플레이어로 참가' : '진행자(GM)로 참가'}</button>` : ''}
      ${isPdf(t) ? '<button class="btn ghost" data-act="doc" data-file="overview">개요 읽기</button>' : '<button class="btn ghost" data-act="intro">사건 개요</button>'}
    </div>
    ${problems.map((x) => `<p class="warn">${esc(x)}</p>`).join('')}
    ${short ? `<p class="muted small">${esc(short)}</p>` : ''}
  </section>
  <div class="select-layout">
    <div class="char-grid">${t.characters.map((c) => charCard(c, holders[c.id] || [])).join('')}</div>
    <aside class="side">
      <div class="panel"><h3>참가자 ${ps.length}명</h3>
        <ul class="plist">${ps.map((p) => `<li class="${p.id === S.pid ? 'me' : ''}">
          <span class="dot ${p.online ? 'on' : ''}"></span>
          <span class="pname">${esc(p.name)}</span>${p.id === hostId() ? '<span class="host-tag">방장</span>' : ''}
          <span class="pchar">${p.gm ? '진행자' : esc(charOf(p.char)?.name || '고르는 중')}</span>
          <span class="pstate ${p.agree === m.selVer ? 'ok' : 'muted'}">${p.agree === m.selVer ? '동의' : '대기'}</span>
        </li>`).join('')}</ul>
      </div>
      ${t.howto ? `<div class="panel"><h3>이 테마 진행 방법</h3><p class="small muted" style="white-space:pre-wrap">${esc(t.howto)}</p></div>` : ''}
    </aside>
  </div>`;
}

function charCard(c, holders) {
  const mine = holders.some((p) => p.id === S.pid);
  const cls = [mine ? 'mine' : '', holders.length && !mine ? 'taken' : '', holders.length > 1 ? 'clash' : ''].join(' ');
  return `<button type="button" class="char-card ${cls}" data-act="pick-char" data-id="${c.id}">
    <span class="glyph">${esc(c.name.slice(0, 1))}</span>
    <span class="name">${esc(c.name)}</span>
    <span class="sub">${esc(c.sub || '')}</span>
    <span class="note">${esc(c.note || '')}</span>
    ${holders.length ? `<span class="who">${holders.map((p) => esc(p.name)).join(', ')}</span>` : ''}
  </button>`;
}

/* 진행 중 */
function stepsBar(current) {
  const t = S.theme;
  const names = [...t.rounds.map((r) => r.name), '투표', '결과'];
  return `<ol class="steps">${names.map((n, i) => `<li class="${i < current ? 'done' : i === current ? 'now' : ''}">${esc(n)}</li>`).join('')}</ol>`;
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
  return `
  <section class="round-head">
    ${stepsBar(m.round)}
    <div class="round-now">
      <p class="eyebrow">${m.round + 1} / ${t.rounds.length} 단계</p>
      <h2>${esc(r.name)}</h2>
      ${r.note ? `<p class="desc">${esc(r.note)}</p>` : ''}
    </div>
    <div class="timer-box">
      <span id="timer" class="timer">${timerText()}</span>
      ${hold ? `<span class="hold-note">연장 중 · ${isHost() ? '원할 때 다음 단계로 넘기세요' : `${esc(hostName)}님이 넘길 때까지 계속돼요`}</span>` : ''}
      <div class="btn-row">
        <button class="btn ${iSkip ? 'on' : 'ghost'}" data-act="skip">${iSkip ? '건너뛰기 취소' : '건너뛰기'} <span class="small">${skipped}/${ps.length}</span></button>
        ${isHost() ? `<button class="btn ghost" data-act="hold">${hold ? '연장 취소' : '연장'}</button>` : ''}
        ${isHost() && hold ? '<button class="btn" data-act="next-step">다음 단계로</button>' : ''}
      </div>
      <span class="small muted">모두 건너뛰기를 누르면 바로 다음 단계로 가요.${isHost() && !hold ? ' 방장이 연장을 누르면 시간이 끝나도 넘어가지 않아요.' : ''}</span>
    </div>
  </section>
  <div class="play-layout">
    <div class="play-main">
      <div class="docs">${docButtons()}</div>
      ${t.cards?.length ? tableView() + handView() : ''}
    </div>
    <aside class="side">${placesPanel()}${playersPanel()}${t.cards?.length ? sharedPanel() : ''}${logPanel()}</aside>
  </div>`;
}

function docBtn(file, title, sub, key = false) {
  return `<button class="doc-btn ${key ? 'key' : ''}" data-act="doc" data-file="${esc(file)}"><strong>${esc(title)}</strong><span>${esc(sub)}</span></button>`;
}

function docButtons() {
  const t = S.theme;
  const c = charOf(me().char);
  const out = [];
  if (isPdf(t)) {
    if (c?.file) out.push(docBtn(`char:${c.id}`, '내 핸드아웃', `${c.name} · 나만 볼 수 있어요`, true));
    out.push(docBtn('overview', '개요', '모두 공개'));
    if (isGM()) {
      t.characters.forEach((ch) => { if (ch.file) out.push(docBtn(`char:${ch.id}`, ch.name, '핸드아웃')); });
      if (t.files?.gm) out.push(docBtn('gm', 'GM 자료', '진행자만'));
      if (t.files?.ending) out.push(docBtn('ending', '엔딩', '진행자만'));
    }
  } else {
    if (c) out.push(`<button class="doc-btn key" data-act="sheet" data-id="${c.id}"><strong>내 캐릭터</strong><span>${esc(c.name)} · 나만 볼 수 있어요</span></button>`);
    out.push('<button class="doc-btn" data-act="intro"><strong>사건 개요</strong><span>모두 공개</span></button>');
    if (isGM()) t.characters.forEach((ch) => out.push(`<button class="doc-btn" data-act="sheet" data-id="${ch.id}"><strong>${esc(ch.name)}</strong><span>캐릭터 시트</span></button>`));
  }
  return out.join('');
}

function picksLeft() {
  const r = S.theme.rounds[meta().round] || {};
  if (r.pick == null) return Infinity;
  const used = Object.values(S.room?.cards || {}).filter((c) => c.takenBy === S.pid && c.takenRound === meta().round).length;
  return Math.max(0, r.pick - used);
}

function pickText() {
  const r = S.theme.rounds[meta().round] || {};
  if (isGM()) return '진행자는 카드를 가져가지 않아요.';
  if (r.pick === 0) return '이번 단계에는 카드를 가져갈 수 없어요.';
  if (r.pick == null) return '카드를 원하는 만큼 가져갈 수 있어요.';
  return `이번 단계에 1인당 ${r.pick}장 · 나는 ${picksLeft()}장 더 가져갈 수 있어요.`;
}

function tableView() {
  const t = S.theme;
  const m = meta();
  const visible = t.cards.filter((c) => (c.round ?? 0) <= m.round);
  const locs = (t.locations || [])
    .map((l) => ({ ...l, cards: visible.filter((c) => c.location === l.id) }))
    .filter((l) => l.cards.length);
  return `<section class="table">
    <div class="table-head"><h3>조사 테이블</h3><p class="small muted">${esc(pickText())}</p></div>
    <div class="locs">${locs.map((l) => `<div class="loc"><h4>${esc(l.name)}</h4><div class="loc-cards">${l.cards.map(tableCard).join('')}</div></div>`).join('') || '<p class="muted">아직 펼쳐진 카드가 없어요.</p>'}</div>
  </section>`;
}

function tableCard(c) {
  const st = cardState(c.id);
  const rot = tilt(c.id, 4);
  if (!st.owner) {
    const can = meta().phase === 'play' && picksLeft() > 0 && !isGM();
    const armed = S.armed === c.id;
    const attrs = can ? `role="button" tabindex="0" data-act="arm" data-id="${c.id}"` : '';
    return `<div class="mcard back ${armed ? 'armed' : ''} ${can ? '' : 'locked'}" style="--rot:${rot}deg" ${attrs} aria-label="${esc(cardTag(c))} 카드, 뒷면">
      <span class="mcard-label"><span class="mcard-loc">${esc(locName(c.location))}</span><span class="mcard-no">${cardNo(c)}</span></span>
      ${armed ? `<button class="btn sm take-btn" data-act="take" data-id="${c.id}">가져가기</button>` : ''}
    </div>`;
  }
  if (st.public) return faceCard(c, '공개');
  return `<div class="mcard slot" style="--rot:${rot}deg">${esc(st.owner === S.pid ? '내가' : who(st.owner))}<br>가져감</div>`;
}

function faceCard(c, badge = '', extra = '') {
  return `<div class="mcard face ${extra}" style="--rot:${tilt(c.id, 3)}deg" role="button" tabindex="0" data-act="view-card" data-id="${c.id}">
    <span class="mcard-loc">${esc(cardTag(c))}</span>
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
      ${here.length ? `<div class="chips">${here.map((p) => `<span class="chip">${esc(p.name)}</span>`).join('')}</div>` : ''}
      ${mineHere ? '<span class="small" style="color:var(--brass)">지금 여기 있어요</span>'
        : `<button class="btn ghost sm" data-act="move" data-id="${rm.id}" ${full ? 'disabled' : ''}>${full ? '꽉 찼어요' : '여기로 이동'}</button>`}
    </div>`;
  }).join('')}</div></div>`;
}

function playersPanel() {
  const m = meta();
  const state = (p) => {
    if (m.phase === 'play') return p.skip === m.round ? '건너뜀' : '';
    if (m.phase === 'vote') return p.gm ? '' : p.vote ? '투표함' : '고민 중';
    return '';
  };
  return `<div class="panel"><h3>참가자</h3><ul class="plist">${players().map((p) => `<li class="${p.id === S.pid ? 'me' : ''}">
    <span class="dot ${p.online ? 'on' : ''}"></span>
    <span class="pname">${esc(p.name)}</span>${p.id === hostId() ? '<span class="host-tag">방장</span>' : ''}
    <span class="pchar">${p.gm ? '진행자' : esc(charOf(p.char)?.name || '')}</span>
    <span class="pstate muted">${esc(state(p))}</span>
  </li>`).join('')}</ul></div>`;
}

function logPanel() {
  const items = Object.values(S.room?.log || {}).sort((a, b) => b.t - a.t).slice(0, 40);
  return `<div class="panel"><h3>기록</h3><ul class="log">${items.map((l) => `<li><time>${clock(l.t)}</time>${esc(l.m)}</li>`).join('') || '<li>아직 기록이 없어요.</li>'}</ul></div>`;
}

/* 투표와 결과 */
function voteView() {
  const t = S.theme;
  const v = t.vote || {};
  const act = actors();
  const mine = me();
  const voted = act.filter((p) => p.vote).length;
  const finalC = v.final ? charOf(v.final) : null;
  const rule = finalC && holderOf(finalC.id) ? `${finalC.name}의 표가 최종 결정이 돼요.` : '가장 많은 표를 받은 쪽으로 결정돼요.';
  return `
  <section class="round-head">${stepsBar(t.rounds.length)}</section>
  <section class="phase-head">
    <p class="eyebrow">최종 투표 · ${voted}/${act.length}명 투표함</p>
    <h2>범인은 누구일까요?</h2>
    <p class="desc">${mine.gm ? '진행자는 투표하지 않아요.' : '한 명을 고르세요. 모두 투표하기 전까지는 바꿀 수 있어요.'} ${esc(rule)}</p>
  </section>
  ${mine.gm ? '' : `<div class="vote-grid">
    ${t.characters.map((c) => `<button class="vote-btn ${mine.vote === c.id ? 'mine' : ''}" data-act="vote" data-id="${c.id}">
      <strong>${esc(c.name)}</strong><span>${esc(holderOf(c.id)?.name || '아무도 맡지 않음')}</span></button>`).join('')}
    ${v.allowNone ? `<button class="vote-btn ${mine.vote === 'none' ? 'mine' : ''}" data-act="vote" data-id="none"><strong>${esc(v.noneLabel || '범인 없음')}</strong><span>사건이 아니라고 봐요</span></button>` : ''}
  </div>`}
  <div class="play-layout">
    <div class="play-main"><div class="docs">${docButtons()}</div></div>
    <aside class="side">${playersPanel()}${logPanel()}</aside>
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
  if (finalP) return { text: label(finalP.vote), how: `${charOf(v.final).name}의 표로 결정`, label };
  const max = Math.max(0, ...Object.values(tally));
  const top = Object.keys(tally).filter((k) => tally[k] === max);
  if (top.length === 1) return { text: label(top[0]), how: `최다 득표 ${max}표`, label };
  return { text: '결정하지 못했어요', how: top.length ? `동점: ${top.map(label).join(', ')}` : '투표 없음', label };
}

function endView() {
  const t = S.theme;
  const act = actors();
  const vd = verdict();
  const truth = t.culprit ? charOf(t.culprit) : null;
  const docs = isPdf(t) ? [
    t.files?.ending ? docBtn('ending', '엔딩', '먼저 함께 읽어 보세요', true) : '',
    t.files?.gm ? docBtn('gm', 'GM 자료', '해설') : '',
    docBtn('overview', '개요', '모두 공개'),
    ...t.characters.filter((c) => c.file).map((c) => docBtn(`char:${c.id}`, c.name, '핸드아웃')),
  ].join('') : '';
  return `
  <section class="round-head">${stepsBar(t.rounds.length + 1)}</section>
  <section class="phase-head">
    <p class="eyebrow">결과 · 여러분이 지목한 쪽은</p>
    <p class="verdict">${esc(vd.text)}</p>
    <p class="small muted">${esc(vd.how)}</p>
  </section>
  <div class="play-layout">
    <div class="play-main result">
      <div class="tbl-wrap"><table class="votes"><thead><tr><th>플레이어</th><th>캐릭터</th><th>투표</th></tr></thead>
        <tbody>${act.map((p) => `<tr><td>${esc(p.name)}</td><td>${esc(charOf(p.char)?.name || '')}</td><td>${esc(p.vote ? vd.label(p.vote) : '-')}</td></tr>`).join('')}</tbody></table></div>
      ${isPdf(t) ? `<div><p class="muted" style="margin-bottom:10px">이제 모든 자료를 볼 수 있어요.</p><div class="docs">${docs}</div></div>` : `
        <div class="panel"><p class="eyebrow">진상</p><h3 style="margin:6px 0 12px">진범은 ${esc(truth?.name || '?')}</h3><p class="story">${esc(t.solution || '')}</p></div>
        <div class="panel"><p class="eyebrow">모두의 비밀</p>${t.characters.map((c) => `<div style="margin-top:14px"><h4>${esc(c.name)}</h4><p class="story small">${esc(c.secret || '')}</p></div>`).join('')}</div>
        ${t.cards?.length ? `<section class="table"><div class="table-head"><h3>모든 단서</h3></div><div class="loc-cards">${t.cards.map((c) => faceCard(c)).join('')}</div></section>` : ''}`}
      <div class="btn-row"><button class="btn ghost" data-act="leave">홈으로</button></div>
    </div>
    <aside class="side">${playersPanel()}${logPanel()}</aside>
  </div>`;
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
  if (S.modal.type === 'card') box.innerHTML = cardModal();
  else if (S.modal.type === 'sheet') box.innerHTML = sheetModal(S.modal.id);
  else if (S.modal.type === 'intro') box.innerHTML = introModal();
  S.modal.fresh = false;
}

const closeBtn = '<button class="btn ghost sm" data-act="close-modal">닫기</button>';

function cardModal() {
  const id = S.modal.id;
  const c = cardOf(id);
  const st = cardState(id);
  const mine = st.owner === S.pid;
  const others = players().filter((p) => p.id !== S.pid && !p.gm);
  const sharedNames = Object.keys(st.shared || {}).filter((k) => st.shared[k]).map(who);
  const status = st.public ? '전체 공개된 카드예요.'
    : mine ? (sharedNames.length ? `보여준 사람: ${sharedNames.join(', ')}` : '아직 아무에게도 보여주지 않았어요.')
      : st.owner ? `${who(st.owner)}님의 카드예요.` : '';
  const live = ['play', 'vote'].includes(meta().phase);
  let actions = '';
  if (mine && live) {
    if (S.modal.mode === 'share') {
      const cand = others.filter((p) => !st.shared?.[p.id]);
      actions = `<form id="f-share" class="sheet">
        <p class="small muted">보여줄 사람을 고르세요. 한 번 보여준 카드는 되돌릴 수 없어요.</p>
        <div class="checks">${cand.map((p) => `<label><input type="checkbox" name="to" value="${p.id}"> ${esc(who(p.id))}</label>`).join('') || '<p class="small muted">더 보여줄 사람이 없어요.</p>'}</div>
        <div class="btn-row"><button class="btn" type="submit" ${cand.length ? '' : 'disabled'}>보여주기</button><button class="btn ghost" type="button" data-act="card-mode">취소</button></div>
      </form>`;
    } else if (S.modal.mode === 'give') {
      actions = `<form id="f-give" class="sheet">
        <p class="small muted">누구에게 넘겨줄까요?</p>
        <div class="checks">${others.map((p) => `<label><input type="radio" name="to" value="${p.id}" required> ${esc(who(p.id))}</label>`).join('')}</div>
        <p class="warn">넘겨주면 이 카드는 더 이상 볼 수 없어요.</p>
        <div class="btn-row"><button class="btn" type="submit">넘겨주기</button><button class="btn ghost" type="button" data-act="card-mode">취소</button></div>
      </form>`;
    } else {
      actions = `<div class="btn-row">
        <button class="btn" data-act="card-public" ${st.public ? 'disabled' : ''}>전체 공개</button>
        <button class="btn ghost" data-act="card-mode" data-mode="share" ${st.public ? 'disabled' : ''}>몇 명에게만 보여주기</button>
        <button class="btn ghost" data-act="card-mode" data-mode="give" ${others.length ? '' : 'disabled'}>넘겨주기</button>
      </div>`;
    }
  }
  return `<div class="modal-head"><p class="eyebrow">단서 카드</p>${closeBtn}</div>
    <article class="paper-card" style="${S.modal.fresh ? '' : 'animation:none'}">
      <span class="mcard-loc">${esc(cardTag(c))}</span>
      <h3>${esc(c.title)}</h3>
      <div class="body">${esc(c.text)}</div>
    </article>
    <p class="small muted">${esc(status)}</p>
    ${actions}`;
}

function sheetModal(charId) {
  const c = charOf(charId);
  const allowed = me().char === charId || isGM() || meta().phase === 'end';
  if (!c || !allowed) return `<div class="modal-head"><h3>볼 수 없어요</h3>${closeBtn}</div>`;
  const sec = (title, body) => (body ? `<section><h4>${title}</h4><div class="body">${esc(body)}</div></section>` : '');
  return `<div class="modal-head"><div><p class="eyebrow">캐릭터 시트 · 비공개</p><h3>${esc(c.name)} <span class="muted small">${esc(c.sub || '')}</span></h3></div>${closeBtn}</div>
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
      <section><h4>등장인물</h4>${t.characters.map((c) => `<p><strong>${esc(c.name)}</strong> <span class="muted small">${esc(c.sub || '')}</span><br><span class="small">${esc(c.public || c.note || '')}</span></p>`).join('')}</section>
    </div>`;
}

/* ---------- PDF 자료 ---------- */
function docInfo(key) {
  const t = S.theme;
  if (key.startsWith('char:')) {
    const c = charOf(key.slice(5));
    return c?.file ? { path: c.file, title: `${c.name} 핸드아웃` } : null;
  }
  const titles = { overview: '개요', ending: '엔딩', gm: 'GM 자료' };
  return t.files?.[key] ? { path: t.files[key], title: titles[key] || key } : null;
}

function canOpenDoc(key) {
  const m = meta();
  if (key === 'overview') return true;
  if (m.phase === 'select') return false;
  if (m.phase === 'end' || isGM()) return true;
  return key.startsWith('char:') && me().char === key.slice(5);
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

async function openDoc(key) {
  if (!canOpenDoc(key)) throw new Error('지금은 볼 수 없는 자료예요.');
  const d = docInfo(key);
  if (!d) throw new Error('자료 파일이 없어요.');
  S.doc.file = d.path;
  S.doc.title = d.title;
  S.doc.bytes = null;
  $('#docpane').hidden = false;
  $('.docpane-title').textContent = d.title;
  const pages = $('.docpane-pages');
  pages.innerHTML = '<p class="docpane-msg">자료를 여는 중…</p>';
  try {
    const bytes = await loadFile(d.path);
    if (S.doc.file !== d.path) return;
    S.doc.bytes = bytes;
    await drawDoc();
  } catch (e) {
    pages.innerHTML = `<p class="docpane-msg">자료를 열지 못했어요. (${esc(e.message)})</p>`;
  }
}

async function drawDoc() {
  $('.docpane-zoom').textContent = `${Math.round(S.doc.zoom * 100)}%`;
  if (S.doc.bytes) await renderPdf($('.docpane-pages'), S.doc.bytes, S.doc.zoom);
}

function closeDoc() {
  $('#docpane').hidden = true;
  $('.docpane-pages').replaceChildren();
  S.doc.file = null;
  S.doc.bytes = null;
}

/* ---------- 들어가기 / 나가기 ---------- */
const newPlayer = (name, now, t) => ({
  name, joinedAt: now, char: null, gm: false, agree: 0, skip: -1, vote: null, online: true, loc: t.rooms?.[0]?.id || null,
});

async function createRoom(t, name, pw) {
  if (!t) throw new Error('테마를 먼저 골라 주세요.');
  if (!name) throw new Error('이름을 적어 주세요.');
  let keyB64 = null;
  if (t.lock) {
    if (!pw) throw new Error('이 테마는 암호가 있어야 방을 만들 수 있어요.');
    const key = await Lock.keyFromPassword(pw, t.lock);
    if (!(await Lock.keyMatches(key, t.lock))) throw new Error('테마 암호가 맞지 않아요.');
    keyB64 = await Lock.exportKey(key);
    lSet(`mm:pw:${t.id}`, pw);
  }
  let code = newCode();
  for (let i = 0; i < 6 && (await S.store.get(`rooms/${code}/meta`)); i++) code = newCode();
  const pid = newId();
  const now = S.store.now();
  await S.store.set(`rooms/${code}`, {
    meta: { theme: t.id, createdAt: now, phase: 'select', round: 0, roundEndsAt: 0, selVer: 1, key: keyB64, host: pid },
    players: { [pid]: newPlayer(name, now, t) },
  });
  await S.store.set(`lobby/${code}`, { theme: t.id, createdAt: now, phase: 'select', count: 1 });
  await S.store.push(`rooms/${code}/log`, { t: now, m: `${name}님이 방을 만들었어요.` });
  lSet('mm:name', name);
  await enterRoom(code, pid);
}

async function joinRoom(code, name) {
  if (!/^[A-Z0-9]{4}$/.test(code)) throw new Error('방 코드는 4자리예요.');
  if (!name) throw new Error('이름을 적어 주세요.');
  const room = await S.store.get(`rooms/${code}`);
  if (!room?.meta) throw new Error('그 코드의 방을 찾을 수 없어요.');
  const t = S.byId[room.meta.theme];
  if (!t) throw new Error('이 사이트에 없는 테마의 방이에요.');
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
  await enterRoom(code, pid);
}

async function enterRoom(code, pid) {
  const room = await S.store.get(`rooms/${code}`);
  const t = room?.meta && S.byId[room.meta.theme];
  if (!t || !room.players?.[pid]?.name) { sSet('mm:cur', null); return false; }
  S.unsub?.();
  S.cancelDisc?.();
  Object.assign(S, { code, pid, theme: t, room, view: 'room', armed: null, modal: null });
  S.seen = { phase: room.meta.phase, round: room.meta.round };
  S.key = room.meta.key ? await Lock.importKey(room.meta.key) : null;
  S.files.clear();
  sSet('mm:cur', JSON.stringify({ code, pid }));
  lSet('mm:last', JSON.stringify({ code, name: room.players[pid].name, title: t.title }));
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
  Object.assign(S, { view: 'home', room: null, code: null, pid: null, theme: null, key: null, modal: null, armed: null });
  closeDoc();
  sSet('mm:cur', null);
  history.replaceState(null, '', location.pathname);
  if (msg) toast(msg);
  render();
}

async function leave() {
  const m = meta();
  if (m.phase !== 'select') { leaveView(); return; }
  if (!confirm('방에서 나갈까요? 고른 캐릭터는 풀려요.')) return;
  const name = me().name;
  const code = S.code;
  const ps = players();
  const ver = (m.selVer || 0) + 1;
  const pid = S.pid;
  const nextHost = hostId() === pid ? ps.find((p) => p.id !== pid)?.id : hostId();
  leaveView();
  lSet('mm:last', null);
  if (ps.length <= 1) {
    await S.store.remove(`rooms/${code}`);
    await S.store.remove(`lobby/${code}`);
  } else {
    await S.store.update(`rooms/${code}`, { [`players/${pid}`]: null, 'meta/selVer': ver, 'meta/host': nextHost });
    await S.store.update(`lobby/${code}`, { count: ps.length - 1 });
    await S.store.push(`rooms/${code}/log`, { t: S.store.now(), m: `${name}님이 나갔어요.` });
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

function announce(m) {
  const { phase, round } = S.seen;
  S.seen = { phase: m.phase, round: m.round };
  if (phase === m.phase && round === m.round) return;
  if (m.phase === 'play' && phase === 'select') toast(`게임 시작! ${isPdf(S.theme) ? "'내 핸드아웃'을 열어 보세요." : "'내 캐릭터'를 확인하세요."}`);
  else if (m.phase === 'play') toast(`'${S.theme.rounds[m.round]?.name}' 단계예요.`);
  else if (m.phase === 'vote') toast('최종 투표 시간이에요.');
  else if (m.phase === 'end') toast('결과가 나왔어요.');
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
  await log(`${who(S.pid)}님이 ${cardTag(cardOf(id))} 카드를 가져갔어요.`);
  openModal({ type: 'card', id });
}

async function makePublic(id) {
  if (cardState(id).owner !== S.pid) return;
  await S.store.update(roomPath(`cards/${id}`), { public: true });
  await log(`${who(S.pid)}님이 '${cardOf(id).title}' 카드를 전체 공개했어요.`);
}

async function shareCard(id, pids) {
  if (cardState(id).owner !== S.pid) return;
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
  if (cardState(id).owner !== S.pid) return;
  if (!to) throw new Error('넘겨줄 사람을 골라 주세요.');
  await S.store.update(roomPath(`cards/${id}`), { owner: to, [`shared/${to}`]: null });
  closeModal();
  await log(`${who(S.pid)}님이 ${cardTag(cardOf(id))} 카드를 ${who(to)}님에게 넘겼어요.`);
}

async function vote(id) {
  if (meta().phase !== 'vote' || isGM()) return;
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

/* ---------- 단계 넘기기 (조건을 본 사람 누구나 시도, 트랜잭션으로 한 번만) ---------- */
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
    if (act.length && act.every((p) => p.vote)) once('end', finishVote);
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
  const res = await S.store.transaction(roomPath('meta'), (m) => {
    if (!m || m.phase !== 'vote') return undefined;
    return { ...m, phase: 'end' };
  });
  if (!res.committed) return;
  await S.store.update(`lobby/${S.code}`, { phase: 'end' });
  await log('모두 투표해서 결과가 공개됐어요.');
}

function tick() {
  if (S.view !== 'room' || !S.room) return;
  const m = meta();
  if (m.phase === 'play') {
    const el = $('#timer');
    if (el) {
      const ts = timerState();
      el.textContent = ts.text;
      el.className = `timer ${ts.cls}`;
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
      busy(joinRoom(el.dataset.code, el.dataset.name).catch((err) => { lSet('mm:last', null); render(); throw err; }));
      break;
    case 'leave': busy(leave()); break;
    case 'copy-link': copyLink(); break;
    case 'pick-char': busy(pickChar(id)); break;
    case 'random': busy(randomAll()); break;
    case 'toggle-gm': busy(toggleGM()); break;
    case 'agree': busy(agree()); break;
    case 'skip': busy(skip()); break;
    case 'hold': busy(toggleHold()); break;
    case 'next-step': busy(nextStep()); break;
    case 'move': busy(move(id)); break;
    case 'arm':
      S.armed = S.armed === id ? null : id;
      render();
      break;
    case 'take': busy(take(id)); break;
    case 'view-card': openModal({ type: 'card', id }); break;
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
      if (S.doc.bytes) window.open(URL.createObjectURL(new Blob([S.doc.bytes], { type: 'application/pdf' })), '_blank');
      break;
    case 'doc-close': closeDoc(); break;
    default: break;
  }
}

function onSubmit(e) {
  const f = e.target;
  e.preventDefault();
  const data = Object.fromEntries(new FormData(f));
  if (f.id === 'f-create') busy(createRoom(S.byId[S.selTheme], (data.name || '').trim(), data.pw || ''));
  else if (f.id === 'f-code') busy(joinRoom((data.code || '').trim().toUpperCase(), (data.name || '').trim()));
  else if (f.id === 'f-share') busy(shareCard(S.modal.id, new FormData(f).getAll('to')));
  else if (f.id === 'f-give') busy(giveCard(S.modal.id, data.to));
}

function onKey(e) {
  if (e.key === 'Escape') {
    if (!$('#docpane').hidden) closeDoc();
    else if (S.modal) closeModal();
    return;
  }
  const el = e.target;
  if ((e.key === 'Enter' || e.key === ' ') && el.getAttribute?.('role') === 'button' && el.dataset.act) {
    e.preventDefault();
    el.click();
  }
}

boot();
