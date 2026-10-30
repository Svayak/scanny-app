const { ipKeyGenerator } = require('express-rate-limit');

// Azure App Service är en hop. Med trust proxy = 1 är req.ip den adress Azure
// såg (högra posten i X-Forwarded-For). Fronten kan lägga till TCP-porten,
// t.ex. "203.0.113.8:54433". Porten får inte bli en egen begränsningsnyckel.

function stripAddressPort(value) {
  const raw = String(value ?? '').trim();
  const bracket = raw.match(/^\[([^\]]+)\](?::\d+)?$/);
  if (bracket) return bracket[1];
  const v4 = raw.match(/^(\d{1,3}(?:\.\d{1,3}){3}):\d+$/);
  if (v4) return v4[1];
  return raw;
}

function clientIp(req) {
  return stripAddressPort(req && req.ip);
}

function rateLimitKey(req, _res) {
  return ipKeyGenerator(clientIp(req));
}

module.exports = { stripAddressPort, clientIp, rateLimitKey };
