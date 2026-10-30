const { redactText, stripSensitive } = require('./redact');
const { publicPrintBridge } = require('./print-api');

const DISPLAY_NAME = 'Scanny';

// Tomt användarnamn betyder "använd central avsändare" och får inte lämna kvar ett gammalt lösenord.
const EMAIL_RE = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;
const MAX_ALERT_RECIPIENTS = 20;
const MAX_TEST_RECIPIENTS = 10;

function applySettingsPatch(body) {
  const patch = { ...body };
  // Bryggnyckel och skrivarstatus sätts bara via /api/print, aldrig via vanliga inställningar.
  for (const key of ['printBridge', 'keyHash', 'bridgeKey', 'bridgeKeyHash']) delete patch[key];
  if (Object.prototype.hasOwnProperty.call(patch, 'alertEmail')) {
    const raw = patch.alertEmail;
    const text = Array.isArray(raw) ? raw.join(', ') : String(raw ?? '');
    patch.alertEmail = text.trim().slice(0, 1000);
  }
  if (Object.prototype.hasOwnProperty.call(patch, 'smtpUser') && !String(patch.smtpUser ?? '').trim()) {
    patch.smtpUser = '';
    patch.smtpPass = '';
    return patch;
  }
  if (!patch.smtpPass) delete patch.smtpPass;
  return patch;
}

function parseAddressList(value) {
  if (Array.isArray(value)) return value.flatMap(parseAddressList);
  return String(value ?? '')
    .split(/[,;\n]/)
    .map(part => part.trim())
    .filter(Boolean);
}

function validEmails(value) {
  const out = [];
  const seen = new Set();
  for (const raw of parseAddressList(value)) {
    if (!EMAIL_RE.test(raw)) continue;
    const key = raw.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

// alertEmail är mottagaren för lagerlarm. Tomt fält faller tillbaka på chefens e-post (email).
function alertRecipients(settings) {
  const s = settings || {};
  const dedicated = String(s.alertEmail ?? '').trim();
  const list = dedicated ? validEmails(dedicated) : validEmails(s.email);
  return list.slice(0, MAX_ALERT_RECIPIENTS);
}

function resolveTestRecipients(settings, toOverride) {
  const hasOverride = toOverride !== undefined && toOverride !== null && String(toOverride).trim() !== '';
  if (!hasOverride) {
    const recipients = alertRecipients(settings);
    if (!recipients.length) return { error: 'Ange en e-postadress för lagerlarm' };
    return { recipients };
  }
  const parsed = parseAddressList(toOverride);
  const recipients = validEmails(toOverride);
  if (!parsed.length || recipients.length !== parsed.length) {
    return { error: 'Ogiltig e-postadress för lagerlarm' };
  }
  if (recipients.length > MAX_TEST_RECIPIENTS) {
    return { error: 'Högst 10 mottagare per testmejl' };
  }
  return { recipients };
}

function createRateLimiter({ windowMs, max, now = () => Date.now() } = {}) {
  const hits = new Map();
  return function allow(key) {
    const t = now();
    const id = String(key ?? '');
    const recent = (hits.get(id) || []).filter(ts => t - ts < windowMs);
    if (recent.length >= max) {
      hits.set(id, recent);
      return false;
    }
    recent.push(t);
    hits.set(id, recent);
    return true;
  };
}

function safeErrorMessage(err, secrets = []) {
  const msg = redactText(err && err.message ? err.message : err, secrets);
  return msg.slice(0, 300);
}

function crossedCriticalThreshold(previousQty, newQty, critical) {
  const prev = Number(previousQty);
  const next = Number(newQty);
  const limit = Number(critical);
  if (!Number.isFinite(prev) || !Number.isFinite(next) || !Number.isFinite(limit)) return false;
  return prev > limit && next <= limit;
}

const SMTP_AUTH_OR_CONNECTION = new Set([
  'EAUTH', 'ECONNECTION', 'ETIMEDOUT', 'ESOCKET', 'ECONNREFUSED', 'ECONNRESET',
  'ENOTFOUND', 'EDNS', 'EAI_AGAIN', 'ETLS', 'EPROTOCOL', 'EHOSTUNREACH', 'ENETUNREACH'
]);

function isAuthOrConnectionError(err) {
  const code = String(err?.code || '').toUpperCase();
  if (SMTP_AUTH_OR_CONNECTION.has(code)) return true;
  const responseCode = Number(err?.responseCode);
  return responseCode === 454 || responseCode === 530 || responseCode === 534 || responseCode === 535;
}

function formatMailbox(name, address) {
  const display = String(name || '').replace(/["<>]/g, '').trim() || DISPLAY_NAME;
  return `"${display}" <${String(address || '').trim()}>`;
}

function createMailService(overrides = {}) {
  const nodemailer = overrides.nodemailer || require('nodemailer');
  const env = overrides.env || process.env;
  const warn = overrides.warn || (message => console.warn(message));
  const createEmailClient = overrides.createEmailClient || ((connectionString) => {
    const { EmailClient } = require('@azure/communication-email');
    return new EmailClient(connectionString);
  });
  const transporterCache = new Map();
  const clientCache = new Map();

  function configuredSecrets(extra = []) {
    return [env.SMTP_PASSWORD, env.ACS_EMAIL_CONNECTION_STRING, ...extra]
      .map(secret => String(secret || ''))
      .filter(secret => secret.length > 0);
  }

  // Explicit hemligheter tas bort även när de är kortare än redactText-gränsen.
  function scrubMailText(value, extra) {
    const secrets = configuredSecrets(extra);
    let msg = String(value ?? '');
    for (const secret of secrets) msg = msg.split(secret).join('***');
    return safeErrorMessage(msg, secrets);
  }

  function centralConfig() {
    const connectionString = String(env.ACS_EMAIL_CONNECTION_STRING || '').trim();
    const from = String(env.EMAIL_FROM || '').trim();
    if (!connectionString || !from) return null;
    return {
      connectionString,
      from,
      replyTo: String(env.EMAIL_REPLY_TO || '').trim()
    };
  }

  // Central SMTP kräver alla tre. Saknas en faller sändningen vidare till ACS.
  function centralSmtpConfig() {
    const host = String(env.SMTP_HOST || '').trim();
    const user = String(env.SMTP_USER || '').trim();
    const pass = String(env.SMTP_PASSWORD || '').trim();
    if (!host || !user || !pass) return null;
    const port = Number(String(env.SMTP_PORT || '').trim()) || 587;
    const fromAddress = String(env.EMAIL_FROM || '').trim() || user;
    const fromName = String(env.EMAIL_FROM_NAME || '').trim() || DISPLAY_NAME;
    return {
      host,
      port,
      user,
      pass,
      from: formatMailbox(fromName, fromAddress),
      replyTo: String(env.EMAIL_REPLY_TO || '').trim()
    };
  }

  function smtpCentral() {
    return centralSmtpConfig() !== null || centralConfig() !== null;
  }

  // 1) verkstadens SMTP  2) central SMTP  3) ACS  4) ingen
  function resolveSender(settings) {
    if (settings?.smtpUser && settings?.smtpPass) return { type: 'smtp' };
    if (centralSmtpConfig()) return { type: 'central-smtp' };
    if (centralConfig()) return { type: 'acs' };
    return null;
  }

  function senderChannel(settings) {
    const type = resolveSender(settings || {})?.type;
    if (type === 'smtp') return 'tenant SMTP';
    if (type === 'central-smtp') return 'central SMTP';
    if (type === 'acs') return 'ACS';
    return null;
  }

  function transportOptions(settings) {
    const host = settings.host || settings.smtpHost || 'smtp.gmail.com';
    const port = Number(settings.port ?? settings.smtpPort) || 587;
    const user = settings.user || settings.smtpUser;
    const pass = settings.pass ?? settings.smtpPass;
    return {
      host,
      port,
      user,
      pass,
      from: settings.from || `"${DISPLAY_NAME}" <${user}>`,
      replyTo: String(settings.replyTo || '').trim()
    };
  }

  function getTransporter(settings) {
    const cfg = transportOptions(settings);
    const key = `${cfg.host}:${cfg.port}:${cfg.user}:${cfg.pass}`;
    let tr = transporterCache.get(key);
    if (!tr) {
      tr = nodemailer.createTransport({
        host: cfg.host,
        port: cfg.port,
        secure: cfg.port === 465,
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        auth: { user: cfg.user, pass: cfg.pass }
      });
      transporterCache.set(key, tr);
    }
    return tr;
  }

  function getEmailClient(connectionString) {
    let client = clientCache.get(connectionString);
    if (!client) {
      client = createEmailClient(connectionString);
      clientCache.set(connectionString, client);
    }
    return client;
  }

  async function sendViaSmtp(settings, message) {
    const cfg = transportOptions(settings);
    const transporter = getTransporter(cfg);
    const payload = {
      from: cfg.from,
      to: message.to,
      subject: message.subject,
      text: message.text
    };
    if (cfg.replyTo) payload.replyTo = cfg.replyTo;
    await transporter.sendMail(payload);
  }

  // Ett auth- eller anslutningsfel från central SMTP loggas avskrubbat och kastas.
  // ACS används inte som tyst reserv — då syns felet i händelseloggen som tidigare.
  async function sendViaCentralSmtp(message) {
    const cfg = centralSmtpConfig();
    if (!cfg) throw new Error('SMTP-uppgifter saknas');
    try {
      await sendViaSmtp(cfg, message);
    } catch (err) {
      const scrubbed = scrubMailText(err && err.message ? err.message : err, [cfg.pass]);
      if (isAuthOrConnectionError(err)) {
        warn(`[mail] Central SMTP avvisade anslutning eller inloggning: ${scrubbed}`);
      }
      throw new Error(scrubbed);
    }
  }

  // ACS kräver att senderAddress är exakt den verifierade MailFrom-adressen.
  // Visningsnamnet "Scanny" sätts på den avsändaren i Azure, inte i anropet.
  async function sendViaAcs(message) {
    const cfg = centralConfig();
    if (!cfg) throw new Error('SMTP-uppgifter saknas');
    const to = validEmails(message.to);
    if (!to.length) throw new Error('Mottagaradress saknas');
    const client = getEmailClient(cfg.connectionString);
    const payload = {
      senderAddress: cfg.from,
      content: { subject: message.subject, plainText: message.text || '' },
      recipients: { to: to.map(address => ({ address })) }
    };
    if (cfg.replyTo) payload.replyTo = [{ address: cfg.replyTo }];
    let result;
    try {
      const poller = await client.beginSend(payload);
      result = await poller.pollUntilDone();
    } catch (err) {
      throw new Error(scrubMailText(err && err.message ? err.message : err, [cfg.connectionString]));
    }
    if (!result || result.status !== 'Succeeded') {
      const detail = result?.error?.message || result?.status || 'okänt fel';
      throw new Error(scrubMailText(detail, [cfg.connectionString]));
    }
  }

  async function sendTenantMail(settings, message, options = {}) {
    const sender = resolveSender(settings || {});
    if (sender?.type === 'smtp') return sendViaSmtp(settings, message);
    if (sender?.type === 'central-smtp') return sendViaCentralSmtp(message);
    if (sender?.type === 'acs') return sendViaAcs(message);
    // Inventeringsrapport försökte tidigare skicka även med bara användarnamn (utan lösenord).
    if (options.allowPartialSmtp && settings?.smtpUser) return sendViaSmtp(settings, message);
    throw new Error('SMTP-uppgifter saknas');
  }

  function planCriticalAlert({ previousQty, newQty, critical, settings }) {
    if (!crossedCriticalThreshold(previousQty, newQty, critical)) return { criticalAlert: false };
    if (!resolveSender(settings)) return { criticalAlert: false };
    if (!alertRecipients(settings).length) return { criticalAlert: false };
    return { criticalAlert: true };
  }

  function shouldSendScheduled(settings, planAllows, nowDay, nowTime) {
    if (!planAllows) return false;
    const s = settings || {};
    if (!s.scheduleTime) return false;
    if (s.scheduleDay === undefined || s.scheduleDay === null) return false;
    if (Number(s.scheduleDay) !== nowDay || s.scheduleTime !== nowTime) return false;
    return resolveSender(s) !== null;
  }

  function publicSettings(settingsObject) {
    const source = settingsObject || {};
    const originalBridge = source.printBridge;
    const s = stripSensitive({ ...source });
    delete s.smtpPass;
    delete s.keyHash;
    delete s.bridgeKey;
    delete s.bridgeKeyHash;
    s.printBridge = publicPrintBridge(originalBridge || {});
    s.smtpCentral = smtpCentral();
    return s;
  }

  return {
    resolveSender,
    senderChannel,
    sendTenantMail,
    planCriticalAlert,
    shouldSendScheduled,
    smtpCentral,
    publicSettings,
    getTransporter
  };
}

const api = createMailService();

module.exports = {
  DISPLAY_NAME,
  applySettingsPatch,
  parseAddressList,
  alertRecipients,
  resolveTestRecipients,
  createRateLimiter,
  safeErrorMessage,
  crossedCriticalThreshold,
  createMailService,
  resolveSender: api.resolveSender,
  senderChannel: api.senderChannel,
  sendTenantMail: api.sendTenantMail,
  planCriticalAlert: api.planCriticalAlert,
  shouldSendScheduled: api.shouldSendScheduled,
  smtpCentral: api.smtpCentral,
  publicSettings: api.publicSettings,
  getTransporter: api.getTransporter
};
