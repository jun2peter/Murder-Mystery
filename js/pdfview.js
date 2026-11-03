// PDF를 캔버스로 그린다(휴대폰에서도 보이도록 pdf.js 사용). 처음 쓸 때만 라이브러리를 불러온다.
const CDN = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/';
let loading = null;

function loadPdfJs() {
  if (!loading) {
    loading = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = `${CDN}pdf.min.js`;
      s.onload = () => {
        window.pdfjsLib.GlobalWorkerOptions.workerSrc = `${CDN}pdf.worker.min.js`;
        resolve(window.pdfjsLib);
      };
      s.onerror = () => { loading = null; reject(new Error('PDF 뷰어를 불러오지 못했어요.')); };
      document.head.appendChild(s);
    });
  }
  return loading;
}

export async function renderPdf(container, bytes, zoom = 1) {
  const lib = await loadPdfJs();
  const doc = await lib.getDocument({
    data: new Uint8Array(bytes.slice(0)),
    cMapUrl: `${CDN}cmaps/`,
    cMapPacked: true,
    standardFontDataUrl: `${CDN}standard_fonts/`,
  }).promise;
  container.replaceChildren();
  const width = Math.max(280, container.clientWidth - 2);
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const cssW = width * zoom;
    const scale = cssW / page.getViewport({ scale: 1 }).width;
    const vp = page.getViewport({ scale: scale * dpr });
    const c = document.createElement('canvas');
    c.width = Math.floor(vp.width);
    c.height = Math.floor(vp.height);
    c.style.width = `${cssW}px`;
    container.appendChild(c);
    await page.render({ canvasContext: c.getContext('2d'), viewport: vp }).promise;
  }
}
