// Statiska filer kommer bara från public/. Den här spärren ligger framför
// express.static så att .env, nycklar, källkartor och serverfiler aldrig kan
// hämtas även om de råkar hamna i katalogen.

const BLOCKED = /(?:^|\/)(?:\.(?:env(?:$|\.)|git(?:$|\/)|svn(?:$|\/)|hg(?:$|\/)|npmrc$|ssh(?:$|\/)|ds_store$)|id_rsa(?:\.pub)?$|credentials\.json$)|(?:^|\/)[^/]*\.(?:pem|key|p12|pfx|map)$/i;

// Namn som bara hör hemma på servern. Spärren gäller även om static-roten
// någon gång pekar fel, eller om filen kopieras in i public/.
const BLOCKED_FILES = new Set([
  'server.js', 'auth.js', 'mail.js', 'models.js', 'redact.js', 'serve-policy.js',
  'label.js', 'pwa.js', 'package.json', 'package-lock.json', 'credentials.json',
  'id_rsa', 'id_rsa.pub'
]);

function decodeRepeatedly(urlPath) {
  let current = String(urlPath).split('?')[0];
  for (let i = 0; i < 3; i++) {
    let next;
    try { next = decodeURIComponent(current); }
    catch { return null; }
    if (next === current) return current;
    current = next;
  }
  return current;
}

function isBlockedStaticPath(urlPath) {
  if (typeof urlPath !== 'string' || !urlPath) return true;
  const decoded = decodeRepeatedly(urlPath);
  if (decoded == null) return true;
  const normalized = decoded.replace(/\\/g, '/');
  if (normalized.includes('\0') || normalized.split('/').some(seg => seg === '..')) return true;
  const base = normalized.split('/').filter(Boolean).pop() || '';
  if (BLOCKED_FILES.has(base.toLowerCase())) return true;
  return BLOCKED.test(normalized);
}

function blockSensitivePaths(req, res, next) {
  const pathOnly = String(req.originalUrl || req.url || '').split('?')[0];
  if (isBlockedStaticPath(req.path) || isBlockedStaticPath(pathOnly)) {
    return res.status(404).end();
  }
  next();
}

function staticOptions() {
  return { dotfiles: 'deny' };
}

module.exports = { isBlockedStaticPath, blockSensitivePaths, staticOptions };
