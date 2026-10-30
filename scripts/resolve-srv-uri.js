#!/usr/bin/env node
// Converts a mongodb+srv:// URI into a plain mongodb:// seedlist URI.
// The self-hosted runner's DNS resolver does not answer SRV/TXT queries,
// so we try system DNS first, then DNS-over-HTTPS (Cloudflare, Google), with retries.
// Reads URI from env MONGODB_URI, writes result to file argv[2]. Never prints the URI.
const dns = require('dns').promises;
const fs = require('fs');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function doh(name, type) {
  const eps = ['https://cloudflare-dns.com/dns-query', 'https://dns.google/resolve'];
  let last;
  for (const ep of eps) {
    try {
      const res = await fetch(`${ep}?name=${encodeURIComponent(name)}&type=${type}`, {
        headers: { accept: 'application/dns-json' }, signal: AbortSignal.timeout(10000) });
      const j = await res.json();
      if (j.Status !== 0) throw new Error(`DoH status ${j.Status}`);
      return (j.Answer || []).filter((a) => a.type === (type === 'SRV' ? 33 : 16)).map((a) => a.data);
    } catch (e) { last = e; }
  }
  throw last;
}
async function srv(name) {
  try {
    const r = await dns.resolveSrv(name);
    if (r.length) return { recs: r.map((x) => `${x.name}:${x.port}`), via: 'system' };
  } catch (_) {}
  const d = await doh(name, 'SRV');
  if (!d.length) throw new Error('no SRV records');
  return { recs: d.map((s) => { const p = s.split(' '); return `${p[3].replace(/\.$/, '')}:${p[2]}`; }), via: 'DoH' };
}
async function txt(name) {
  try { return (await dns.resolveTxt(name)).map((c) => c.join('')); } catch (_) {}
  try { return (await doh(name, 'TXT')).map((s) => s.replace(/"/g, '')); } catch (_) { return []; }
}
(async () => {
  const uri = process.env.MONGODB_URI || '';
  const out = process.argv[2];
  if (!uri.startsWith('mongodb+srv://')) { fs.writeFileSync(out, uri, { mode: 0o600 }); console.log('URI is not SRV; unchanged'); return; }
  const m = uri.match(/^mongodb\+srv:\/\/(?:([^@/]*)@)?([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error('could not parse URI');
  const [, cred, host, path = '/', query = ''] = m;
  for (let i = 1; i <= 4; i++) {
    try {
      const { recs, via } = await srv(`_mongodb._tcp.${host}`);
      const params = new URLSearchParams(query.replace(/^\?/, ''));
      for (const t of await txt(host)) for (const [k, v] of new URLSearchParams(t)) if (!params.has(k)) params.set(k, v);
      if (!params.has('tls') && !params.has('ssl')) params.set('tls', 'true');
      const res = `mongodb://${cred ? cred + '@' : ''}${recs.join(',')}${path}?${params}`;
      console.log(`::add-mask::${res}`);
      fs.writeFileSync(out, res, { mode: 0o600 });
      console.log(`Resolved ${recs.length} host(s) via ${via}`);
      return;
    } catch (e) {
      console.log(`SRV attempt ${i} failed: ${e.message}`);
      if (i < 4) await sleep(5000 * 2 ** (i - 1));
    }
  }
  process.exit(1);
})();
