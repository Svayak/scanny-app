// Webbmanifest för installation via Chrome "Lägg till på startskärmen".
// Ingen hemlighet hör hemma här — bara namn, färger och ikoner.

const THEME = '#0c0f0a';
const ACCENT = '#4ade80';

function safeStartPath(input, fallback) {
  const fb = fallback || '/app';
  if (Array.isArray(input)) input = input[0];
  if (typeof input !== 'string') return fb;
  const raw = input.trim();
  if (!raw || raw.length > 256) return fb;
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return fb;
  if (raw.includes('\\') || raw.includes('..')) return fb;
  if (/[\u0000-\u001F\u007F]/.test(raw)) return fb;
  const pathOnly = raw.split('?')[0];
  if (!/^\/[A-Za-z0-9._~!$&'()*+,;=:@%/-]*$/.test(pathOnly)) return fb;
  const q = raw.includes('?') ? raw.slice(raw.indexOf('?') + 1) : '';
  if (q && !/^[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*$/.test(q)) return fb;
  return raw;
}

function buildWebManifest(startUrl) {
  const start = safeStartPath(startUrl, '/app');
  return {
    id: start,
    name: 'Scanny',
    short_name: 'Scanny',
    description: 'Lagerhantering för verkstäder',
    lang: 'sv',
    start_url: start,
    scope: '/',
    display: 'standalone',
    display_override: ['fullscreen', 'standalone'],
    background_color: THEME,
    theme_color: THEME,
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' }
    ]
  };
}

function sendManifest(queryStart, res) {
  const body = buildWebManifest(safeStartPath(queryStart, '/app'));
  res.set('Content-Type', 'application/manifest+json; charset=utf-8');
  res.set('Cache-Control', 'no-cache');
  res.json(body);
  return body;
}

module.exports = {
  THEME,
  ACCENT,
  safeStartPath,
  buildWebManifest,
  sendManifest
};
