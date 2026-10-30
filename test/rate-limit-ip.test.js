const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const express = require('express');
const rateLimit = require('express-rate-limit');
const { ipKeyGenerator } = rateLimit;
const { stripAddressPort, clientIp, rateLimitKey } = require('../client-ip');

function listen(app) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => resolve(server));
    server.on('error', reject);
  });
}

function close(server) {
  return new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()));
}

function appWithLimit(max) {
  const app = express();
  app.set('trust proxy', 1);
  app.use(rateLimit({
    windowMs: 60 * 1000,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: rateLimitKey,
    handler: (_req, res) => res.status(429).json({ error: 'limited' })
  }));
  app.get('/', (req, res) => res.json({ ip: clientIp(req), key: rateLimitKey(req) }));
  return app;
}

async function hit(port, xff) {
  const headers = xff === undefined ? {} : { 'x-forwarded-for': xff };
  const res = await fetch(`http://127.0.0.1:${port}/`, { headers });
  const body = await res.json();
  return { status: res.status, body };
}

describe('client address behind Azure', () => {
  it('strips a port from IPv4 and bracketed IPv6 and leaves a bare IPv6 address intact', () => {
    assert.equal(stripAddressPort('203.0.113.8:54433'), '203.0.113.8');
    assert.equal(stripAddressPort(' 203.0.113.8 '), '203.0.113.8');
    assert.equal(stripAddressPort('[2001:db8::10]:443'), '2001:db8::10');
    assert.equal(stripAddressPort('[2001:db8::10]'), '2001:db8::10');
    assert.equal(stripAddressPort('2001:db8::10'), '2001:db8::10');
  });

  it('keys the limiter on the client Express selects, without the Azure port', async () => {
    const server = await listen(appWithLimit(1));
    try {
      const first = await hit(server.address().port, '203.0.113.8:11111');
      const sameClient = await hit(server.address().port, '198.51.100.9, 203.0.113.8:22222');
      const other = await hit(server.address().port, '198.51.100.9:33333');
      assert.equal(first.status, 200);
      assert.equal(first.body.ip, '203.0.113.8');
      assert.equal(first.body.key, '203.0.113.8');
      assert.equal(first.body.ip.includes(':'), false);
      assert.equal(sameClient.status, 429);
      assert.equal(other.status, 200);
      assert.equal(other.body.ip, '198.51.100.9');
    } finally {
      await close(server);
    }
  });

  it('does not raise the forwarded-for or invalid-ip validation when the port is stripped', async () => {
    const errors = [];
    const original = console.error;
    console.error = (...args) => errors.push(args.map(String).join(' '));
    const server = await listen(appWithLimit(5));
    try {
      const v4 = await hit(server.address().port, '203.0.113.8:54433');
      const v6 = await hit(server.address().port, '[2001:db8::10]:443');
      const direct = await hit(server.address().port, undefined);
      assert.equal(v4.status, 200);
      assert.equal(v6.status, 200);
      assert.equal(v6.body.ip, '2001:db8::10');
      assert.equal(v6.body.key, ipKeyGenerator('2001:db8::10'));
      assert.equal(v6.body.key.includes(':443'), false);
      assert.equal(direct.status, 200);
      assert.equal(direct.body.ip, '127.0.0.1');
      const logged = errors.join('\n');
      assert.equal(logged.includes('ERR_ERL_UNEXPECTED_X_FORWARDED_FOR'), false);
      assert.equal(logged.includes('ERR_ERL_INVALID_IP_ADDRESS'), false);
    } finally {
      console.error = original;
      await close(server);
    }
  });

  it('trusts one Azure hop and gives every limiter the same client key', () => {
    const server = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
    const trustAt = server.indexOf("app.set('trust proxy', 1)");
    const firstLimiter = server.indexOf('rateLimit(');
    assert.ok(trustAt > 0 && trustAt < firstLimiter);
    assert.equal(server.includes("app.set('trust proxy', true)"), false);
    const blocks = server.split('rateLimit(').slice(1);
    assert.ok(blocks.length >= 5);
    for (const block of blocks) {
      assert.match(block.slice(0, 500), /keyGenerator:\s*rateLimitKey/);
    }
    const testAlert = server.slice(server.indexOf("app.post('/api/settings/test-alert'"), server.indexOf("app.get('/api/logs'"));
    assert.match(testAlert, /res\.json\(\{ ok: true, sent: decision\.recipients\.length, channel \}\)/);
    assert.match(server.slice(server.indexOf('function serverError'), server.indexOf('function escHtml')), /SMTP_PASSWORD/);
  });
});
