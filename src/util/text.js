// Shared text utilities used by both clients.

function norm(s) {
  return (s || '')
    .toLowerCase()
    .replace(/\s*\(official.+?\)|\s*\[official.+?\]/g, ' ')
    .replace(/official video|official audio|lyrics?|mv|hd|4k|remaster(ed)?/g, ' ')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const STOPWORDS = new Set([
  'the','a','an','and','of','to','in','on','for','with','by','feat','ft','vs','x','remix','edit'
]);

function tokens(s) {
  return norm(s).split(' ')
    .filter(t => t && t.length >= 3 && !STOPWORDS.has(t));
}

function jaccardTitle(a, b) {
  const A = new Set(tokens(a));
  const B = new Set(tokens(b));
  if (A.size === 0 && B.size === 0) return 1;
  let inter = 0;
  for (const t of A) if (B.has(t)) inter++;
  const uni = A.size + B.size - inter;
  return uni ? inter / uni : 0;
}

function hasUsableTokens(...parts) {
  const joined = parts.filter(Boolean).join(' ').trim();
  if (!joined) return false;
  const t = tokens(joined);
  if (t.length > 0) return true;
  const letters = (norm(joined).match(/[\p{L}\p{N}]/gu) || []).length;
  return letters >= 2;
}

module.exports = { norm, tokens, jaccardTitle, STOPWORDS, hasUsableTokens };
