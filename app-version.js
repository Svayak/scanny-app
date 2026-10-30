const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const FILES = [
  'public/kiosk.html',
  'public/admin.html',
  'public/js/app.js',
  'public/js/scan-wedge.js',
  'public/js/kiosk-update.js',
  'public/js/product-search.js',
  'public/js/user-link.js',
  'public/js/mode-timer.js',
  'public/css/style.css',
  'public/sw.js'
];

function assetVersion(rootDir) {
  if (process.env.APP_VERSION) return String(process.env.APP_VERSION);
  const hash = crypto.createHash('sha256');
  for (const rel of FILES) {
    hash.update(rel);
    const file = path.join(rootDir, rel);
    hash.update(fs.existsSync(file) ? fs.readFileSync(file) : 'missing');
  }
  return hash.digest('hex').slice(0, 12);
}

function injectAssetVersion(html, version) {
  return String(html).split('__APP_VERSION__').join(String(version));
}

module.exports = { FILES, assetVersion, injectAssetVersion };
