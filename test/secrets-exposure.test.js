const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { spawnSync } = require('node:child_process');
const express = require('express');

process.env.JWT_SECRET = process.env.JWT_SECRET || 'unit-test-jwt-secret-value';
process.env.ADMIN_SECRET = process.env.ADMIN_SECRET || 'unit-test-admin-secret';

const { adminAuthorized } = require('../auth');
const { publicSettings } = require('../mail');
const redact = require('../redact');
const { blockSensitivePaths, staticOptions, isBlockedStaticPath } = require('../serve-policy');

const root = path.join(__dirname, '..');
function read(rel) { return fs.readFileSync(path.join(root, rel), 'utf8'); }

const CLIENT_EXT = new Set(['.js', '.html', '.css', '.svg', '.json', '.webmanifest', '.map', '.txt']);
const FORBIDDEN = [
  { name: 'mongodb credentials', re: /mongodb(?:\+srv)?:\/\/(?!USERNAME:PASSWORD@)[^\s/'"]+:[^\s@'"]+@/i },
  { name: 'acs access key', re: /accesskey\s*=\s*(?!\*{3})[^\s;'"]{8,}/i },
  { name: 'azure account key', re: /AccountKey\s*=\s*[^\s;'"]+/i },
  { name: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'embedded JWT_SECRET', re: /JWT_SECRET\s*[:=]\s*['"][^'"]+['"]/ },
  { name: 'embedded ADMIN_SECRET', re: /ADMIN_SECRET\s*[:=]\s*['"][^'"]+['"]/ },
  { name: 'embedded MONGODB_URI', re: /MONGODB_URI\s*[:=]\s*['"]mongodb/i },
  { name: 'embedded ACS connection', re: /ACS_EMAIL_CONNECTION_STRING\s*[:=]\s*['"][^'"]+['"]/ },
  { name: 'aws access key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'source map comment', re: /sourceMappingURL/i }
];

function walk(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '.git') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, acc);
    else acc.push(full);
  }
  return acc;
}

function shellBodies(text, key) {
  const lines = text.split(/\r?\n/);
  const bodies = [];
  const header = new RegExp('^(\\s*)' + key + ':\\s*(.*)$');
  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(header);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();
    if (rest && rest !== '|' && rest !== '|-') {
      bodies.push(rest);
      continue;
    }
    const buf = [];
    for (let j = i + 1; j < lines.length; j++) {
      if (lines[j].trim() === '') { buf.push(lines[j]); continue; }
      const ind = lines[j].match(/^\s*/)[0].length;
      if (ind <= indent) break;
      buf.push(lines[j]);
      i = j;
    }
    bodies.push(buf.join('\n'));
  }
  return bodies;
}

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function get(port, urlPath) {
  return new Promise((resolve, reject) => {
    const req = http.get({ hostname: '127.0.0.1', port, path: urlPath }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
  });
}

describe('secret redaction for API payloads', () => {
  const password = 'stored-smtp-password';
  const pinHash = '$2a$12$pinhashpinhashpinhashpinha';
  const passHash = '$2a$12$abcdefghijklmnopqrstuvwx';
  const connection = 'endpoint=https://example.communication.azure.com/;accesskey=super-secret-value';

  it('strips smtp passwords, nested secrets and connection strings from settings', () => {
    const pub = publicSettings({
      email: 'chef@verkstad.se',
      workshop: 'Verkstan',
      smtpHost: 'smtp.gmail.com',
      smtpPort: 587,
      smtpUser: 'verkstad@gmail.com',
      smtpPass: password,
      smtp: { user: 'verkstad@gmail.com', pass: 'nested-secret-value' },
      note: connection
    });
    const json = JSON.stringify(pub);
    assert.equal(pub.smtpPass, undefined);
    assert.equal(pub.smtp.pass, undefined);
    assert.equal(pub.smtp.user, 'verkstad@gmail.com');
    assert.equal(pub.smtpUser, 'verkstad@gmail.com');
    assert.equal(pub.email, 'chef@verkstad.se');
    assert.equal(typeof pub.smtpCentral, 'boolean');
    assert.equal(json.includes(password), false);
    assert.equal(json.includes('nested-secret-value'), false);
    assert.equal(json.includes('super-secret-value'), false);
    assert.match(json, /accesskey=\*\*\*/);
  });

  it('returns an auth profile without password, pin or tenant smtp password', () => {
    const settings = publicSettings({ workshop: 'Verkstan', smtpUser: 'verkstad@gmail.com', smtpPass: password });
    const payload = redact.publicAuthPayload(
      { _id: 'u1', name: 'Ada', email: 'ada@verkstad.se', role: 'staff', password: passHash, pin: pinHash, permissions: { canScan: true } },
      { _id: 't1', name: 'Verkstan', slug: 'verkstan', status: 'active', plan: 'pro', settings: { smtpPass: password, smtpUser: 'verkstad@gmail.com' } },
      settings
    );
    const json = JSON.stringify(payload);
    assert.equal(payload.user.hasPin, true);
    assert.equal(payload.user.password, undefined);
    assert.equal(payload.user.pin, undefined);
    assert.equal(payload.user.name, 'Ada');
    assert.equal(payload.tenant.slug, 'verkstan');
    assert.equal(payload.tenant.settings.smtpPass, undefined);
    assert.equal(payload.tenant.settings.smtpUser, 'verkstad@gmail.com');
    assert.equal(json.includes(password), false);
    assert.equal(json.includes(passHash), false);
    assert.equal(json.includes(pinHash), false);
    assert.equal(json.includes('settings'), true);
  });

  it('omits settings and secrets from the superadmin tenant list', () => {
    const row = redact.publicSuperadminTenant(
      { _id: 't1', name: 'Verkstan', slug: 'verkstan', status: 'active', plan: 'bas', createdAt: '2026-01-01', settings: { smtpPass: password, smtpUser: 'a@b.c' } },
      { userCount: 2, productCount: 4, adminEmail: 'chef@verkstad.se', adminName: 'Ada' }
    );
    const json = JSON.stringify(row);
    assert.equal(row.settings, undefined);
    assert.equal(row.adminEmail, 'chef@verkstad.se');
    assert.equal(row.userCount, 2);
    assert.equal(json.includes(password), false);
    assert.equal(json.includes('smtpUser'), false);
  });

  it('redacts connection strings in client-visible logs and known passwords at write time', () => {
    const raw = `Schemalagd beställning misslyckades: auth ${connection} ${password} mongodb+srv://dbuser:db-password@cluster.example.net/scanny`;
    const written = redact.redactText(raw, [password, connection]);
    assert.equal(written.includes(password), false);
    assert.equal(written.includes('super-secret-value'), false);
    assert.equal(written.includes('db-password'), false);
    const log = redact.publicLog({ msg: raw, type: 'warn' });
    assert.match(log.msg, /Schemalagd beställning misslyckades/);
    assert.equal(log.msg.includes('super-secret-value'), false);
    assert.equal(log.msg.includes('db-password'), false);
    assert.match(log.msg, /mongodb:\/\/\*\*\*/);
  });
});

describe('admin secret fails closed', () => {
  it('accepts only the exact configured secret', () => {
    const previous = process.env.ADMIN_SECRET;
    process.env.ADMIN_SECRET = 'unit-test-admin-secret';
    try {
      assert.equal(adminAuthorized('unit-test-admin-secret'), true);
      assert.equal(adminAuthorized('unit-test-admin-secret '), false);
      assert.equal(adminAuthorized(''), false);
      assert.equal(adminAuthorized(undefined), false);
      assert.equal(adminAuthorized(['unit-test-admin-secret']), false);
      delete process.env.ADMIN_SECRET;
      assert.equal(adminAuthorized('unit-test-admin-secret'), false);
      process.env.ADMIN_SECRET = '';
      assert.equal(adminAuthorized(''), false);
    } finally {
      if (previous === undefined) delete process.env.ADMIN_SECRET;
      else process.env.ADMIN_SECRET = previous;
    }
  });

  it('warns and keeps running when ADMIN_SECRET is unset', () => {
    const env = { ...process.env, JWT_SECRET: 'unit-test-jwt-secret-value' };
    delete env.ADMIN_SECRET;
    const result = spawnSync(process.execPath, ['-e', "require('./auth')"], { cwd: root, env, encoding: 'utf8' });
    assert.equal(result.status, 0);
    assert.match(result.stderr, /ADMIN_SECRET saknas/);
    assert.equal(result.stderr.includes('unit-test-admin-secret'), false);
  });
});

describe('static serving cannot expose secrets', () => {
  it('blocks dotfiles, source maps, keys and server filenames', () => {
    for (const blocked of ['/.env', '/.env.local', '/.git/config', '/js/app.js.map', '/keys/id_rsa', '/credentials.json', '/server.js', '/auth.js', '/package.json', '/%2eenv', '/%252eenv', '/../.env']) {
      assert.equal(isBlockedStaticPath(blocked), true, blocked);
    }
    for (const allowed of ['/', '/index.html', '/js/app.js', '/js/scan-wedge.js', '/sw.js', '/css/style.css', '/api/settings', '/api/auth/me', '/api/db', '/kiosk/verkstad']) {
      assert.equal(isBlockedStaticPath(allowed), false, allowed);
    }
  });

  describe('http', () => {
    let server;
    let port;
    const poison = 's3cret-password-value';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanny-static-'));

    before(async () => {
      fs.writeFileSync(path.join(dir, '.env'), `MONGODB_URI=mongodb+srv://user:${poison}@cluster.example.net/scanny\nJWT_SECRET=${poison}\n`);
      fs.writeFileSync(path.join(dir, 'app.js.map'), `{"sourcesContent":["JWT_SECRET='${poison}'"]}`);
      fs.writeFileSync(path.join(dir, 'server.js'), `module.exports = { JWT_SECRET: '${poison}' }`);
      fs.writeFileSync(path.join(dir, 'ok.js'), 'console.log("ready");');
      fs.mkdirSync(path.join(dir, 'nested'));
      fs.writeFileSync(path.join(dir, 'nested', 'key.pem'), '-----BEGIN PRIVATE KEY-----\n' + poison + '\n-----END PRIVATE KEY-----');
      const app = express();
      app.use(blockSensitivePaths);
      app.use(express.static(dir, staticOptions()));
      server = await listen(app);
      port = server.address().port;
    });

    after(() => new Promise((resolve, reject) => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (!server) return resolve();
      server.close(err => err ? reject(err) : resolve());
    }));

    async function assertHidden(urlPath) {
      const res = await get(port, urlPath);
      assert.notEqual(res.status, 200, urlPath);
      assert.equal(res.body.includes(poison), false, urlPath);
      assert.equal(res.body.includes('BEGIN PRIVATE KEY'), false, urlPath);
    }

    it('serves ordinary client files and hides secret files that sit in the static root', async () => {
      const ok = await get(port, '/ok.js');
      assert.equal(ok.status, 200);
      assert.match(ok.body, /ready/);
      assert.equal(ok.body.includes(poison), false);
      for (const urlPath of ['/.env', '/app.js.map', '/server.js', '/nested/key.pem', '/%2eenv', '/%252eenv', '/../.env']) {
        await assertHidden(urlPath);
      }
    });
  });

  it('serves the real public directory without secrets, maps or server files', async () => {
    const app = express();
    app.use(blockSensitivePaths);
    app.use(express.static(path.join(root, 'public'), {
      ...staticOptions(),
      setHeaders(res, filePath) {
        if (path.basename(filePath) === 'sw.js') res.setHeader('Cache-Control', 'no-cache');
      }
    }));
    const server = await listen(app);
    const port = server.address().port;
    try {
      for (const urlPath of ['/', '/index.html', '/js/app.js', '/js/scan-wedge.js', '/sw.js', '/admin.html', '/kiosk.html', '/login.html', '/superadmin.html', '/css/style.css', '/favicon.svg']) {
        const res = await get(port, urlPath);
        assert.equal(res.status, 200, urlPath);
        for (const rule of FORBIDDEN) {
          assert.equal(rule.re.test(res.body), false, `${urlPath} matched ${rule.name}`);
        }
        assert.equal(res.body.includes('process.env'), false, urlPath);
      }
      for (const urlPath of ['/.env', '/.git/config', '/server.js', '/auth.js', '/mail.js', '/package.json', '/js/app.js.map', '/credentials.json']) {
        const res = await get(port, urlPath);
        assert.notEqual(res.status, 200, urlPath);
      }
      const sw = await get(port, '/sw.js');
      assert.equal(sw.status, 200);
    } finally {
      await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
    }
  });
});

describe('client assets and pipelines', () => {
  const clientFiles = [
    ...walk(path.join(root, 'public')),
    path.join(root, 'app.js'),
    path.join(root, 'index.html'),
    path.join(root, 'style.css')
  ].filter(file => CLIENT_EXT.has(path.extname(file)));

  it('has no source maps and no secret material in client files', () => {
    const maps = walk(root).filter(file => file.endsWith('.map') && !file.includes(`${path.sep}node_modules${path.sep}`));
    assert.deepEqual(maps, []);
    assert.ok(clientFiles.length >= 8);
    for (const file of clientFiles) {
      const text = fs.readFileSync(file, 'utf8');
      const rel = path.relative(root, file);
      for (const rule of FORBIDDEN) {
        assert.equal(rule.re.test(text), false, `${rel} matched ${rule.name}`);
      }
      assert.equal(text.includes('MONGODB_URI'), false, rel);
      assert.equal(text.includes('JWT_SECRET'), false, rel);
      assert.equal(text.includes('ADMIN_SECRET'), false, rel);
      assert.equal(text.includes('ACS_EMAIL_CONNECTION_STRING'), false, rel);
      assert.equal(text.includes('process.env'), false, rel);
    }
  });

  it('posts a typed smtp password and never reads one back from settings', () => {
    const js = read('public/js/app.js');
    assert.match(js, /if \(pass\) body\.smtpPass = pass/);
    assert.equal(js.includes('settings.smtpPass'), false);
    assert.equal(js.includes('s.smtpPass'), false);
    assert.equal(read('public/superadmin.html').includes('smtpPass'), false);
  });

  it('wires API responses and static hosting through the redactors', () => {
    const server = read('server.js');
    assert.match(server, /publicAuthPayload/);
    assert.match(server, /publicSuperadminTenant/);
    assert.match(server, /publicLog/);
    assert.match(server, /adminAuthorized/);
    assert.match(server, /blockSensitivePaths/);
    assert.match(server, /staticOptions\(\)/);
    assert.match(server, /Schemalagd beställning misslyckades: \$\{detail\}/);
    assert.match(server, /safeErrorMessage\(err, \[s\.smtpPass/);
    assert.equal(server.includes('res.json({ user, tenant })'), false);
    assert.equal(server.includes('...t.toObject()'), false);
    assert.equal(server.includes('err.message'), false);
    assert.match(read('serve-policy.js'), /dotfiles:\s*'deny'/);
  });

  it('keeps .env.example as placeholders and ignores real secret files', () => {
    const example = read('.env.example');
    assert.match(example, /USERNAME:PASSWORD/);
    assert.match(example, /byt-ut-detta/);
    assert.equal(/accesskey\s*=\s*[A-Za-z0-9+/]{16,}/i.test(example), false);
    const ignore = read('.gitignore');
    for (const line of ['.env', '.env.*', '!.env.example', '*.pem', '*.key', '*.p12', '*.pfx', '*.map', 'credentials.json', 'id_rsa']) {
      assert.equal(ignore.split(/\r?\n/).includes(line), true, line);
    }
  });

  it('does not interpolate secrets into workflow shell scripts', () => {
    const files = walk(path.join(root, '.github', 'workflows'));
    assert.ok(files.length >= 2);
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      const bodies = [...shellBodies(text, 'run'), ...shellBodies(text, 'inlineScript')];
      assert.ok(bodies.length >= 1, file);
      for (const body of bodies) {
        assert.equal(body.includes('${{'), false, path.basename(file) + '\n' + body);
        assert.equal(body.includes('secrets.'), false, path.basename(file));
      }
      assert.equal(/mongodb(?:\+srv)?:\/\/[^\s/'"]+:[^\s@'"]+@/i.test(text), false, file);
      assert.equal(/AccountKey=/.test(text), false, file);
    }
    const backup = read('.github/workflows/backup.yml');
    assert.match(backup, /MONGODB_URI:\s*\$\{\{\s*secrets\.MONGODB_URI\s*\}\}/);
    assert.match(backup, /AZURE_STORAGE_CONNECTION_STRING:\s*\$\{\{\s*secrets\.AZURE_STORAGE_CONNECTION_STRING\s*\}\}/);
    assert.match(backup, /mongodump --uri="\$MONGODB_URI"/);
    assert.equal(backup.includes('--connection-string'), false);
    assert.match(backup, /node scripts\/scrub-stream\.js/);
    const deploy = read('.github/workflows/main_scanny-app.yml');
    assert.match(deploy, /include-hidden-files:\s*false/);
    assert.match(deploy, /-name '\.env'/);
    assert.match(deploy, /-name '\*\.pem'/);
    assert.match(deploy, /-name '\*\.map'/);
    assert.match(deploy, /!\s*-name '\.env\.example'/);
    assert.match(deploy, /rm -rf \.git test/);
  });

  it('scrubs backup command output before it can be logged', () => {
    const uri = 'mongodb+srv://scanny-user:s3cret-password-value@cluster.example.net/scanny';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scanny-scrub-'));
    const file = path.join(dir, 'err.txt');
    fs.writeFileSync(file, `Failed ${uri} AccountKey=abcDEF1234567890/=+ accesskey=super-secret-value`);
    try {
      const result = spawnSync(process.execPath, [path.join(root, 'scripts', 'scrub-stream.js'), file, '4'], {
        env: { ...process.env, MONGODB_URI: uri },
        encoding: 'utf8'
      });
      assert.equal(result.status, 4);
      assert.match(result.stderr, /Failed \*\*\*/);
      assert.equal(result.stderr.includes('mongodb+srv://'), false);
      assert.equal(result.stderr.includes('s3cret-password-value'), false);
      assert.equal(result.stderr.includes('abcDEF1234567890'), false);
      assert.equal(result.stderr.includes('super-secret-value'), false);
      assert.equal(result.stdout.includes(uri), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
