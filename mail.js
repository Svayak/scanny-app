const DISPLAY_NAME = 'Scanny';

// Tomt användarnamn betyder "använd central avsändare" och får inte lämna kvar ett gammalt lösenord.
function applySettingsPatch(body) {
  const patch = { ...body };
  if (Object.prototype.hasOwnProperty.call(patch, 'smtpUser') && !String(patch.smtpUser ?? '').trim()) {
    patch.smtpUser = '';
    patch.smtpPass = '';
    return patch;
  }
  if (!patch.smtpPass) delete patch.smtpPass;
  return patch;
}

function crossedCriticalThreshold(previousQty, newQty, critical) {
  const prev = Number(previousQty);
  const next = Number(newQty);
  const limit = Number(critical);
  if (!Number.isFinite(prev) || !Number.isFinite(next) || !Number.isFinite(limit)) return false;
  return prev > limit && next <= limit;
}

function scrubSecrets(value, connectionString) {
  let msg = String(value ?? '');
  if (connectionString) msg = msg.split(connectionString).join('***');
  return msg.replace(/accesskey=[^;\s'"]+/gi, 'accesskey=***');
}

function createMailService(overrides = {}) {
  const nodemailer = overrides.nodemailer || require('nodemailer');
  const env = overrides.env || process.env;
  const createEmailClient = overrides.createEmailClient || ((connectionString) => {
    const { EmailClient } = require('@azure/communication-email');
    return new EmailClient(connectionString);
  });
  const transporterCache = new Map();
  const clientCache = new Map();

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

  function smtpCentral() {
    return centralConfig() !== null;
  }

  function resolveSender(settings) {
    if (settings?.smtpUser && settings?.smtpPass) return { type: 'smtp' };
    if (centralConfig()) return { type: 'acs' };
    return null;
  }

  function getTransporter(settings) {
    const host = settings.smtpHost || 'smtp.gmail.com';
    const port = Number(settings.smtpPort) || 587;
    const key = `${host}:${port}:${settings.smtpUser}:${settings.smtpPass}`;
    let tr = transporterCache.get(key);
    if (!tr) {
      tr = nodemailer.createTransport({
        host,
        port,
        secure: port === 465,
        pool: true,
        maxConnections: 3,
        maxMessages: 100,
        auth: { user: settings.smtpUser, pass: settings.smtpPass }
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
    const transporter = getTransporter(settings);
    await transporter.sendMail({
      from: `"${DISPLAY_NAME}" <${settings.smtpUser}>`,
      to: message.to,
      subject: message.subject,
      text: message.text
    });
  }

  // ACS kräver att senderAddress är exakt den verifierade MailFrom-adressen.
  // Visningsnamnet "Scanny" sätts på den avsändaren i Azure, inte i anropet.
  async function sendViaAcs(message) {
    const cfg = centralConfig();
    if (!cfg) throw new Error('SMTP-uppgifter saknas');
    const client = getEmailClient(cfg.connectionString);
    const payload = {
      senderAddress: cfg.from,
      content: { subject: message.subject, plainText: message.text || '' },
      recipients: { to: [{ address: message.to }] }
    };
    if (cfg.replyTo) payload.replyTo = [{ address: cfg.replyTo }];
    let result;
    try {
      const poller = await client.beginSend(payload);
      result = await poller.pollUntilDone();
    } catch (err) {
      throw new Error(scrubSecrets(err && err.message ? err.message : err, cfg.connectionString));
    }
    if (!result || result.status !== 'Succeeded') {
      const detail = result?.error?.message || result?.status || 'okänt fel';
      throw new Error(scrubSecrets(detail, cfg.connectionString));
    }
  }

  async function sendTenantMail(settings, message, options = {}) {
    const sender = resolveSender(settings || {});
    if (sender?.type === 'smtp') return sendViaSmtp(settings, message);
    if (sender?.type === 'acs') return sendViaAcs(message);
    // Inventeringsrapport försökte tidigare skicka även med bara användarnamn (utan lösenord).
    if (options.allowPartialSmtp && settings?.smtpUser) return sendViaSmtp(settings, message);
    throw new Error('SMTP-uppgifter saknas');
  }

  function planCriticalAlert({ previousQty, newQty, critical, settings }) {
    if (!crossedCriticalThreshold(previousQty, newQty, critical)) return { criticalAlert: false };
    if (!resolveSender(settings)) return { criticalAlert: false };
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
    const s = { ...(settingsObject || {}) };
    delete s.smtpPass;
    s.smtpCentral = smtpCentral();
    return s;
  }

  return {
    resolveSender,
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
  crossedCriticalThreshold,
  createMailService,
  resolveSender: api.resolveSender,
  sendTenantMail: api.sendTenantMail,
  planCriticalAlert: api.planCriticalAlert,
  shouldSendScheduled: api.shouldSendScheduled,
  smtpCentral: api.smtpCentral,
  publicSettings: api.publicSettings,
  getTransporter: api.getTransporter
};
