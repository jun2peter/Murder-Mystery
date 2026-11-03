// 암호가 걸린 테마 파일(.bin = 16바이트 IV + AES-256-CBC 암호문)을 브라우저에서 푼다.
// 키는 PBKDF2-SHA256으로 암호에서 만든다. tools/lock-files.ps1과 짝을 이룬다.
const enc = new TextEncoder();
const toB64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)));
const fromB64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function keyFromPassword(password, lock) {
  const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: fromB64(lock.salt), iterations: lock.iter, hash: 'SHA-256' },
    base,
    { name: 'AES-CBC', length: 256 },
    true,
    ['decrypt'],
  );
}

export async function decrypt(key, bytes) {
  const u = new Uint8Array(bytes);
  return crypto.subtle.decrypt({ name: 'AES-CBC', iv: u.slice(0, 16) }, key, u.slice(16));
}

export async function keyMatches(key, lock) {
  try {
    const out = await decrypt(key, fromB64(lock.check));
    return new TextDecoder().decode(out) === 'MM-OK';
  } catch {
    return false;
  }
}

export const exportKey = async (key) => toB64(await crypto.subtle.exportKey('raw', key));
export const importKey = (b64) => crypto.subtle.importKey('raw', fromB64(b64), { name: 'AES-CBC' }, false, ['decrypt']);
