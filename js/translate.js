// 일본어 자료를 쪽마다 한국어로 기계 번역한다. 글자가 들어 있는 PDF는 글자를 그대로 쓰고,
// 그림으로 된 쪽은 브라우저 안에서 글자를 읽어(OCR) 번역한다. 번역은 보는 사람의 브라우저가 한다.
const TESS = 'https://cdn.jsdelivr.net/npm/tesseract.js@5.1.1/dist/tesseract.min.js';
const GTX = 'https://translate.googleapis.com/translate_a/single?client=gtx&dt=t';
const CJK = '\\u3000-\\u30ff\\u3400-\\u9fff\\uff00-\\uffef';

let tessLoading = null;
let worker = null;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('글자 인식 도구를 불러오지 못했어요.'));
    document.head.appendChild(s);
  });
}

async function ocrWorker() {
  if (!tessLoading) {
    tessLoading = loadScript(TESS)
      .then(() => window.Tesseract.createWorker('jpn'))
      .then((w) => { worker = w; return w; })
      .catch((e) => { tessLoading = null; throw e; });
  }
  return tessLoading;
}

// OCR 결과는 일본어 글자 사이에 빈칸이 끼므로 지운다.
const tidy = (s) => s
  .replace(new RegExp(`(?<=[${CJK}])[ \\t]+(?=[${CJK}])`, 'g'), '')
  .replace(/\n{3,}/g, '\n\n')
  .trim();

// 그림·장식에서 잘못 읽은 줄(일본어가 거의 없는 줄)은 버린다. 시각(15:10)은 남긴다.
const KANA = new RegExp(`[${CJK}]`, 'g');
const keepLine = (l) => !l.trim() || (l.match(KANA) || []).length >= 2 || /\d{1,2}[:：]\d{2}/.test(l);

export async function ocr(canvas) {
  const w = await ocrWorker();
  const { data } = await w.recognize(canvas);
  return tidy((data.text || '').split('\n').filter(keepLine).join('\n'));
}

// 긴 글은 줄 단위로 나눠 보낸다.
function chunks(text, max = 1800) {
  const out = [];
  let cur = '';
  for (const line of text.split('\n')) {
    if (cur && cur.length + line.length + 1 > max) { out.push(cur); cur = ''; }
    cur = cur ? `${cur}\n${line}` : line;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out;
}

async function viaGoogle(text, from) {
  const res = await fetch(`${GTX}&sl=${from}&tl=ko`, { method: 'POST', body: new URLSearchParams({ q: text }) });
  if (!res.ok) throw new Error(`번역 서버 응답 ${res.status}`);
  const j = await res.json();
  return (j?.[0] || []).map((x) => x?.[0] || '').join('');
}

let local = null;
async function viaChrome(text, from) {
  if (!('Translator' in self)) throw new Error('이 브라우저는 번역 기능이 없어요.');
  local ||= self.Translator.create({ sourceLanguage: from, targetLanguage: 'ko' });
  return (await local).translate(text);
}

// PDF는 문장 중간에서 줄이 바뀌므로, 문장이 안 끝난 줄은 다음 줄과 잇는다. 짧은 줄은 제목으로 본다.
const END = /[。！？!?」』）)]$/;
function unwrap(text) {
  const out = [];
  for (const l of text.split('\n').map((s) => s.trim())) {
    const prev = out[out.length - 1];
    const heading = l.length < 8 && !END.test(l);
    if (prev && l && prev.length >= 12 && !END.test(prev) && !heading) out[out.length - 1] = prev + l;
    else out.push(l);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n');
}

export async function toKorean(text, from = 'ja') {
  const parts = chunks(unwrap(text));
  const out = [];
  for (const p of parts) {
    try {
      out.push(await viaGoogle(p, from));
    } catch (e) {
      out.push(await viaChrome(p, from).catch(() => { throw e; }));
    }
  }
  return out.join('\n');
}

export const googleLink = (text, from = 'ja') =>
  `https://translate.google.com/?sl=${from}&tl=ko&op=translate&text=${encodeURIComponent(text.slice(0, 4500))}`;
