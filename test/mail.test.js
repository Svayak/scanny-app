const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const {
  createMailService,
  applySettingsPatch,
  crossedCriticalThreshold,
  alertRecipients,
  resolveTestRecipients,
  createRateLimiter,
  safeErrorMessage
} = require('../mail');

const FROM = 'noreply@scanny.se';
const CONNECTION = 'endpoint=https://example.communication.azure.com/;accesskey=super-secret-value';

function acsEnv(extra = {}) {
  return {
    ACS_EMAIL_CONNECTION_STRING: CONNECTION,
    EMAIL_FROM: FROM,
    ...extra
  };
}

function fakeNodemailer(bag) {
  return {
    createTransport(opts) {
      const transport = {
        sendMail: async (msg) => {
          if (bag.fail) throw bag.fail;
          bag.sent.push({ opts, msg });
        }
      };
      bag.transports.push(opts);
      return transport;
    }
  };
}

function fakeAcs(bag) {
  return (connectionString) => {
    bag.connections.push(connectionString);
    return {
      beginSend: async (payload) => {
        bag.payloads.push(payload);
        if (bag.fail) throw new Error(bag.fail);
        return { pollUntilDone: async () => bag.result || { status: 'Succeeded', id: 'op-1' } };
      }
    };
  };
}

function service({ env = {}, nodemailerBag, acsBag, warn } = {}) {
  return createMailService({
    env,
    warn,
    nodemailer: fakeNodemailer(nodemailerBag || { sent: [], transports: [] }),
    createEmailClient: fakeAcs(acsBag || { connections: [], payloads: [] })
  });
}

const CENTRAL_PASSWORD = 'workspace-app-password';

function centralSmtpEnv(extra = {}) {
  return {
    SMTP_HOST: 'smtp.gmail.com',
    SMTP_PORT: '587',
    SMTP_USER: 'nils@altitudmedia.se',
    SMTP_PASSWORD: CENTRAL_PASSWORD,
    EMAIL_FROM: 'noreply@altitudmedia.se',
    EMAIL_FROM_NAME: 'Scanny',
    ...extra
  };
}

describe('resolveSender', () => {
  it('returns null when neither tenant SMTP nor ACS is configured', () => {
    const mail = service();
    assert.equal(mail.resolveSender({}), null);
    assert.equal(mail.resolveSender({ smtpUser: 'a@b.c' }), null);
    assert.equal(mail.smtpCentral(), false);
  });

  it('uses tenant SMTP when user and password are set, even if ACS is configured', () => {
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ env: acsEnv(), acsBag });
    assert.deepEqual(mail.resolveSender({ smtpUser: 'verkstad@gmail.com', smtpPass: 'app-pass' }), { type: 'smtp' });
    assert.equal(acsBag.connections.length, 0);
  });

  it('uses ACS only when both connection string and EMAIL_FROM are set', () => {
    const mail = service({ env: acsEnv() });
    assert.deepEqual(mail.resolveSender({}), { type: 'acs' });
    assert.equal(mail.smtpCentral(), true);
    assert.equal(service({ env: { ACS_EMAIL_CONNECTION_STRING: CONNECTION } }).resolveSender({}), null);
    assert.equal(service({ env: { EMAIL_FROM: FROM } }).resolveSender({}), null);
    assert.equal(service({ env: { ACS_EMAIL_CONNECTION_STRING: '  ', EMAIL_FROM: '  ' } }).smtpCentral(), false);
  });

  it('prefers central SMTP over ACS when host, user and password are set', () => {
    const mail = service({ env: { ...centralSmtpEnv(), ...acsEnv() } });
    assert.deepEqual(mail.resolveSender({}), { type: 'central-smtp' });
    assert.equal(mail.senderChannel({}), 'central SMTP');
    assert.equal(mail.senderChannel({ smtpUser: 'verkstad@gmail.com', smtpPass: 'app-pass' }), 'tenant SMTP');
    assert.equal(mail.smtpCentral(), true);
    assert.deepEqual(service({ env: centralSmtpEnv() }).resolveSender({ smtpUser: 'a@b.c' }), { type: 'central-smtp' });
  });

  it('ignores a partial central SMTP config and keeps ACS', () => {
    const base = centralSmtpEnv();
    for (const key of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
      const env = { ...base, ...acsEnv() };
      env[key] = '   ';
      const mail = service({ env });
      assert.deepEqual(mail.resolveSender({}), { type: 'acs' }, key);
      assert.equal(mail.senderChannel({}), 'ACS');
    }
    assert.equal(service({ env: centralSmtpEnv({ SMTP_PORT: '' }) }).resolveSender({}).type, 'central-smtp');
  });

  it('reports no channel when nothing is configured', () => {
    const mail = service();
    assert.equal(mail.senderChannel({}), null);
    assert.equal(mail.senderChannel({ smtpUser: 'a@b.c' }), null);
  });

  it('exposes only the smtpCentral boolean and never the secret', () => {
    const mail = service({ env: acsEnv({ EMAIL_REPLY_TO: 'info@scanny.se' }) });
    const pub = mail.publicSettings({ email: 'chef@verkstad.se', smtpUser: '', smtpPass: 'stored-pass', smtpHost: 'smtp.gmail.com' });
    assert.equal(pub.smtpPass, undefined);
    assert.equal(pub.smtpCentral, true);
    assert.equal(typeof pub.smtpCentral, 'boolean');
    assert.equal(JSON.stringify(pub).includes('super-secret-value'), false);
    assert.equal(JSON.stringify(pub).includes('accesskey'), false);

    const central = service({ env: centralSmtpEnv({ EMAIL_REPLY_TO: 'info@altitudmedia.se' }) });
    const centralPub = central.publicSettings({ workshop: 'Verkstan' });
    assert.equal(centralPub.smtpCentral, true);
    const centralJson = JSON.stringify(centralPub);
    assert.equal(centralJson.includes(CENTRAL_PASSWORD), false);
    assert.equal(centralJson.includes('nils@altitudmedia.se'), false);
    assert.equal(centralJson.includes('SMTP_PASSWORD'), false);
  });
});

describe('sendTenantMail', () => {
  const tenant = { smtpHost: 'smtp.gmail.com', smtpPort: 587, smtpUser: 'verkstad@gmail.com', smtpPass: 'app-pass', email: 'chef@verkstad.se' };

  it('sends through nodemailer with secure false on port 587 and display name Scanny', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ env: acsEnv(), nodemailerBag, acsBag });
    await mail.sendTenantMail(tenant, { to: tenant.email, subject: 'Order', text: 'hej' });
    assert.equal(acsBag.payloads.length, 0);
    assert.equal(nodemailerBag.transports.length, 1);
    assert.equal(nodemailerBag.transports[0].secure, false);
    assert.equal(nodemailerBag.transports[0].port, 587);
    assert.equal(nodemailerBag.sent[0].msg.from, '"Scanny" <verkstad@gmail.com>');
    assert.equal(nodemailerBag.sent[0].msg.to, tenant.email);
  });

  it('sets secure when the port is 465', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const mail = service({ nodemailerBag });
    await mail.sendTenantMail({ ...tenant, smtpPort: 465 }, { to: 'a@b.c', subject: 's', text: 't' });
    await mail.sendTenantMail({ ...tenant, smtpPort: '465', smtpUser: 'other@b.c' }, { to: 'a@b.c', subject: 's', text: 't' });
    assert.equal(nodemailerBag.transports[0].secure, true);
    assert.equal(nodemailerBag.transports[0].port, 465);
    assert.equal(nodemailerBag.transports[1].secure, true);
  });

  it('sends through ACS with the env from-address and optional reply-to', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ env: acsEnv({ EMAIL_REPLY_TO: ' info@scanny.se ' }), nodemailerBag, acsBag });
    await mail.sendTenantMail({ email: 'chef@verkstad.se' }, { to: 'chef@verkstad.se', subject: 'Order', text: 'hej' });
    assert.equal(nodemailerBag.sent.length, 0);
    assert.equal(acsBag.connections[0], CONNECTION);
    assert.equal(acsBag.payloads[0].senderAddress, FROM);
    assert.deepEqual(acsBag.payloads[0].recipients, { to: [{ address: 'chef@verkstad.se' }] });
    assert.deepEqual(acsBag.payloads[0].replyTo, [{ address: 'info@scanny.se' }]);
    assert.equal(acsBag.payloads[0].content.subject, 'Order');
    assert.equal(JSON.stringify(acsBag.payloads[0]).includes('super-secret-value'), false);
  });

  it('omits reply-to when EMAIL_REPLY_TO is empty', async () => {
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ env: acsEnv({ EMAIL_REPLY_TO: '   ' }), acsBag });
    await mail.sendTenantMail({}, { to: 'chef@verkstad.se', subject: 's', text: 't' });
    assert.equal(acsBag.payloads[0].replyTo, undefined);
  });

  it('throws the same error as before when nothing is configured, without calling a transport', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ nodemailerBag, acsBag });
    await assert.rejects(
      () => mail.sendTenantMail({ smtpHost: 'smtp.gmail.com' }, { to: 'a@b.c', subject: 's', text: 't' }),
      /SMTP-uppgifter saknas/
    );
    assert.equal(nodemailerBag.transports.length, 0);
    assert.equal(acsBag.connections.length, 0);
  });

  it('still attempts nodemailer for a username without password when partial SMTP is allowed and ACS is off', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const mail = service({ nodemailerBag });
    await mail.sendTenantMail({ smtpUser: 'only-user@b.c', smtpPass: '' }, { to: 'a@b.c', subject: 's', text: 't' }, { allowPartialSmtp: true });
    assert.equal(nodemailerBag.sent.length, 1);
    await assert.rejects(
      () => mail.sendTenantMail({ smtpUser: 'only-user@b.c' }, { to: 'a@b.c', subject: 's', text: 't' }),
      /SMTP-uppgifter saknas/
    );
  });

  it('scrubs the connection string from ACS errors', async () => {
    const acsBag = { connections: [], payloads: [], fail: `auth failed ${CONNECTION}` };
    const mail = service({ env: acsEnv(), acsBag });
    await assert.rejects(
      () => mail.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' }),
      (err) => {
        assert.equal(err.message.includes('super-secret-value'), false);
        assert.equal(err.message.includes('accesskey='), false);
        assert.match(err.message, /auth failed/);
        return true;
      }
    );
  });

  it('sends central SMTP with display name, alias From and no reply-to unless one is set', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ env: { ...acsEnv(), ...centralSmtpEnv({ EMAIL_REPLY_TO: '   ' }) }, nodemailerBag, acsBag });
    await mail.sendTenantMail({ email: 'chef@verkstad.se' }, { to: 'chef@verkstad.se', subject: 'Order', text: 'hej' });
    assert.equal(acsBag.payloads.length, 0);
    assert.equal(acsBag.connections.length, 0);
    assert.equal(nodemailerBag.transports.length, 1);
    assert.equal(nodemailerBag.transports[0].host, 'smtp.gmail.com');
    assert.equal(nodemailerBag.transports[0].port, 587);
    assert.equal(nodemailerBag.transports[0].secure, false);
    assert.equal(nodemailerBag.transports[0].auth.user, 'nils@altitudmedia.se');
    assert.equal(nodemailerBag.transports[0].auth.pass, CENTRAL_PASSWORD);
    assert.equal(nodemailerBag.sent[0].msg.from, '"Scanny" <noreply@altitudmedia.se>');
    assert.equal(nodemailerBag.sent[0].msg.replyTo, undefined);
    assert.equal(nodemailerBag.sent[0].msg.to, 'chef@verkstad.se');
  });

  it('uses EMAIL_FROM_NAME and EMAIL_REPLY_TO, and implicit TLS on port 465', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const mail = service({
      env: centralSmtpEnv({ SMTP_PORT: '465', EMAIL_FROM_NAME: ' Altitud ', EMAIL_REPLY_TO: ' info@altitudmedia.se ' }),
      nodemailerBag
    });
    await mail.sendTenantMail({}, { to: 'chef@verkstad.se', subject: 's', text: 't' });
    assert.equal(nodemailerBag.transports[0].port, 465);
    assert.equal(nodemailerBag.transports[0].secure, true);
    assert.equal(nodemailerBag.sent[0].msg.from, '"Altitud" <noreply@altitudmedia.se>');
    assert.equal(nodemailerBag.sent[0].msg.replyTo, 'info@altitudmedia.se');

    const defaultName = { sent: [], transports: [] };
    const named = service({
      env: centralSmtpEnv({ EMAIL_FROM_NAME: '  ', SMTP_PORT: '' }),
      nodemailerBag: defaultName
    });
    await named.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' });
    assert.equal(defaultName.transports[0].port, 587);
    assert.equal(defaultName.transports[0].secure, false);
    assert.equal(defaultName.sent[0].msg.from, '"Scanny" <noreply@altitudmedia.se>');
    assert.equal(defaultName.sent[0].msg.replyTo, undefined);

    const bag = { sent: [], transports: [] };
    const fallback = service({ env: centralSmtpEnv({ EMAIL_FROM_NAME: '', EMAIL_FROM: '' }), nodemailerBag: bag });
    await fallback.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' });
    assert.equal(bag.sent[0].msg.from, '"Scanny" <nils@altitudmedia.se>');
    assert.equal(bag.sent[0].msg.replyTo, undefined);
  });

  it('does not fall back to ACS when central SMTP auth or connection fails, and scrubs the password', async () => {
    const warnings = [];
    const nodemailerBag = {
      sent: [],
      transports: [],
      fail: Object.assign(new Error(`Invalid login: ${CENTRAL_PASSWORD}`), { code: 'EAUTH', responseCode: 535 })
    };
    const acsBag = { connections: [], payloads: [] };
    const mail = service({
      env: { ...centralSmtpEnv(), ...acsEnv() },
      nodemailerBag,
      acsBag,
      warn: message => warnings.push(message)
    });
    await assert.rejects(
      () => mail.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' }),
      (err) => {
        assert.match(err.message, /Invalid login/);
        assert.equal(err.message.includes(CENTRAL_PASSWORD), false);
        return true;
      }
    );
    assert.equal(acsBag.connections.length, 0);
    assert.equal(acsBag.payloads.length, 0);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Central SMTP avvisade anslutning eller inloggning/);
    assert.equal(warnings[0].includes(CENTRAL_PASSWORD), false);
    assert.equal(warnings[0].includes('super-secret-value'), false);

    const quiet = [];
    const refused = service({
      env: centralSmtpEnv(),
      nodemailerBag: { sent: [], transports: [], fail: Object.assign(new Error(`connect ${CENTRAL_PASSWORD}`), { code: 'ECONNREFUSED' }) },
      acsBag: { connections: [], payloads: [] },
      warn: message => quiet.push(message)
    });
    await assert.rejects(() => refused.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' }));
    assert.equal(quiet.length, 1);
    assert.equal(quiet[0].includes(CENTRAL_PASSWORD), false);

    const envelopeWarnings = [];
    const envelopeBag = { connections: [], payloads: [] };
    const envelope = service({
      env: { ...centralSmtpEnv(), ...acsEnv() },
      nodemailerBag: { sent: [], transports: [], fail: Object.assign(new Error(`recipient refused ${CENTRAL_PASSWORD}`), { code: 'EENVELOPE' }) },
      acsBag: envelopeBag,
      warn: message => envelopeWarnings.push(message)
    });
    await assert.rejects(
      () => envelope.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' }),
      (err) => {
        assert.equal(err.message.includes(CENTRAL_PASSWORD), false);
        return true;
      }
    );
    assert.equal(envelopeWarnings.length, 0);
    assert.equal(envelopeBag.connections.length, 0);

    const short = 's3cret';
    const shortWarnings = [];
    const shortMail = service({
      env: centralSmtpEnv({ SMTP_PASSWORD: short }),
      nodemailerBag: { sent: [], transports: [], fail: Object.assign(new Error(`bad login ${short}`), { code: 'EAUTH' }) },
      warn: message => shortWarnings.push(message)
    });
    await assert.rejects(
      () => shortMail.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' }),
      (err) => {
        assert.equal(err.message.includes(short), false);
        return true;
      }
    );
    assert.equal(shortWarnings[0].includes(short), false);
  });

  it('keeps tenant SMTP ahead of central SMTP', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const mail = service({ env: { ...centralSmtpEnv(), ...acsEnv() }, nodemailerBag });
    await mail.sendTenantMail(tenant, { to: tenant.email, subject: 'Order', text: 'hej' });
    assert.equal(nodemailerBag.transports[0].auth.user, 'verkstad@gmail.com');
    assert.equal(nodemailerBag.sent[0].msg.from, '"Scanny" <verkstad@gmail.com>');
    assert.equal(nodemailerBag.sent[0].msg.replyTo, undefined);
  });

  it('fails when ACS reports a non-success status and strips the connection string', async () => {
    const acsBag = { connections: [], payloads: [], result: { status: 'Failed', error: { message: `bounced ${CONNECTION}` } } };
    const mail = service({ env: acsEnv(), acsBag });
    await assert.rejects(
      () => mail.sendTenantMail({}, { to: 'a@b.c', subject: 's', text: 't' }),
      (err) => {
        assert.match(err.message, /bounced/);
        assert.equal(err.message.includes('super-secret-value'), false);
        return true;
      }
    );
  });
});

describe('critical threshold', () => {
  const settings = { smtpUser: 'verkstad@gmail.com', smtpPass: 'app-pass', email: 'chef@verkstad.se' };

  it('is true only when quantity crosses from above the limit to at or below it', () => {
    assert.equal(crossedCriticalThreshold(3, 2, 2), true);
    assert.equal(crossedCriticalThreshold(2, 1, 2), false);
    assert.equal(crossedCriticalThreshold(1, 0, 2), false);
    assert.equal(crossedCriticalThreshold(1, 0, 0), true);
    assert.equal(crossedCriticalThreshold(6, 5, 2), false);
    assert.equal(crossedCriticalThreshold(2, 2, 2), false);
  });

  it('sets criticalAlert only when the crossing can be queued', () => {
    const smtp = service();
    assert.deepEqual(smtp.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings }), { criticalAlert: true });
    assert.deepEqual(smtp.planCriticalAlert({ previousQty: 2, newQty: 1, critical: 2, settings }), { criticalAlert: false });
    assert.deepEqual(smtp.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings: {} }), { criticalAlert: false });

    const acs = service({ env: acsEnv() });
    assert.deepEqual(acs.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings: { email: 'chef@verkstad.se' } }), { criticalAlert: true });
    assert.deepEqual(acs.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings: { alertEmail: 'lager@verkstad.se' } }), { criticalAlert: true });
    assert.deepEqual(acs.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings: {} }), { criticalAlert: false });
    assert.deepEqual(acs.planCriticalAlert({ previousQty: 2, newQty: 1, critical: 2, settings: {} }), { criticalAlert: false });
  });

  it('queues the critical mail on the resolved transport and leaves later scans unsent', async () => {
    const nodemailerBag = { sent: [], transports: [] };
    const mail = service({ nodemailerBag });
    const first = mail.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings });
    const again = mail.planCriticalAlert({ previousQty: 2, newQty: 1, critical: 2, settings });
    assert.equal(first.criticalAlert, true);
    assert.equal(again.criticalAlert, false);
    if (first.criticalAlert) {
      await mail.sendTenantMail(settings, { to: settings.email, subject: '⚠️ KRITISKT: Filter', text: 'varning' });
    }
    assert.equal(nodemailerBag.sent.length, 1);
    assert.equal(nodemailerBag.sent[0].msg.subject, '⚠️ KRITISKT: Filter');
  });
});

describe('scheduled orders', () => {
  it('requires the resolver, the plan and the matching Stockholm slot', () => {
    const mail = service({ env: acsEnv() });
    const open = { scheduleDay: 1, scheduleTime: '07:00' };
    assert.equal(mail.shouldSendScheduled(open, true, 1, '07:00'), true);
    assert.equal(mail.shouldSendScheduled(open, false, 1, '07:00'), false);
    assert.equal(mail.shouldSendScheduled(open, true, 2, '07:00'), false);
    assert.equal(mail.shouldSendScheduled({ ...open, scheduleTime: '' }, true, 1, '07:00'), false);
    assert.equal(mail.shouldSendScheduled({ scheduleDay: 0, scheduleTime: '07:00' }, true, 0, '07:00'), true);

    const withoutAcs = service();
    assert.equal(withoutAcs.shouldSendScheduled(open, true, 1, '07:00'), false);
    assert.equal(withoutAcs.shouldSendScheduled({ ...open, smtpUser: 'a@b.c', smtpPass: 'x' }, true, 1, '07:00'), true);
    assert.equal(withoutAcs.shouldSendScheduled({ ...open, smtpUser: 'a@b.c' }, true, 1, '07:00'), false);
  });
});

describe('applySettingsPatch', () => {
  it('clears the stored password when the SMTP username is cleared', () => {
    assert.equal(applySettingsPatch({ smtpUser: '', smtpPass: 'old' }).smtpPass, '');
    assert.equal(applySettingsPatch({ smtpUser: '   ', email: 'chef@verkstad.se' }).smtpPass, '');
    assert.equal(applySettingsPatch({ smtpUser: null }).smtpUser, '');
  });

  it('keeps the existing password when the username stays and the password field is blank', () => {
    const patch = applySettingsPatch({ smtpUser: 'verkstad@gmail.com', smtpPass: '' });
    assert.equal(patch.smtpUser, 'verkstad@gmail.com');
    assert.equal(Object.prototype.hasOwnProperty.call(patch, 'smtpPass'), false);
  });

  it('trims the alert recipient list and still clears SMTP when the username is emptied', () => {
    const patch = applySettingsPatch({ smtpUser: '  ', alertEmail: '  lager@verkstad.se, chef@verkstad.se  ', smtpPass: 'old' });
    assert.equal(patch.alertEmail, 'lager@verkstad.se, chef@verkstad.se');
    assert.equal(patch.smtpPass, '');
    assert.equal(applySettingsPatch({ alertEmail: 'x'.repeat(1200) }).alertEmail.length, 1000);
  });
});

describe('alert recipients', () => {
  it('uses alertEmail and falls back to the existing chef address when it is empty', () => {
    assert.deepEqual(alertRecipients({ alertEmail: 'lager@verkstad.se, inkop@verkstad.se' }), ['lager@verkstad.se', 'inkop@verkstad.se']);
    assert.deepEqual(alertRecipients({ alertEmail: ' lager@verkstad.se ; inkop@verkstad.se ', email: 'chef@verkstad.se' }), ['lager@verkstad.se', 'inkop@verkstad.se']);
    assert.deepEqual(alertRecipients({ alertEmail: '', email: 'chef@verkstad.se' }), ['chef@verkstad.se']);
    assert.deepEqual(alertRecipients({ email: 'chef@verkstad.se, lager@verkstad.se' }), ['chef@verkstad.se', 'lager@verkstad.se']);
    assert.deepEqual(alertRecipients({ alertEmail: 'Lager@Verkstad.se, lager@verkstad.se' }), ['Lager@Verkstad.se']);
    assert.deepEqual(alertRecipients({ alertEmail: 'inte-en-adress', email: 'chef@verkstad.se' }), []);
    assert.deepEqual(alertRecipients({}), []);
  });

  it('sends one critical mail to every alert recipient', async () => {
    const acsBag = { connections: [], payloads: [] };
    const mail = service({ env: acsEnv(), acsBag });
    const settings = { alertEmail: 'lager@verkstad.se, inkop@verkstad.se', email: 'chef@verkstad.se' };
    const decision = mail.planCriticalAlert({ previousQty: 3, newQty: 2, critical: 2, settings });
    assert.equal(decision.criticalAlert, true);
    const recipients = alertRecipients(settings);
    await mail.sendTenantMail(settings, { to: recipients.join(', '), subject: '⚠️ KRITISKT: Filter', text: 'varning' });
    assert.deepEqual(acsBag.payloads[0].recipients.to.map(r => r.address), recipients);
    assert.equal(JSON.stringify(acsBag.payloads[0]).includes('chef@verkstad.se'), false);
  });

  it('rejects a test send with a bad address and accepts comma-separated recipients', () => {
    const saved = { alertEmail: '', email: 'chef@verkstad.se' };
    assert.deepEqual(resolveTestRecipients(saved), { recipients: ['chef@verkstad.se'] });
    assert.deepEqual(resolveTestRecipients(saved, 'lager@verkstad.se, inkop@verkstad.se'), { recipients: ['lager@verkstad.se', 'inkop@verkstad.se'] });
    assert.equal(resolveTestRecipients(saved, 'lager@verkstad.se, nej').error, 'Ogiltig e-postadress för lagerlarm');
    assert.equal(resolveTestRecipients({}).error, 'Ange en e-postadress för lagerlarm');
    const many = Array.from({ length: 11 }, (_, i) => `a${i}@verkstad.se`).join(', ');
    assert.equal(resolveTestRecipients(saved, many).error, 'Högst 10 mottagare per testmejl');
  });
});

describe('test alert rate limit', () => {
  it('allows five calls per tenant inside the window and then blocks', () => {
    let now = 1_000_000;
    const allow = createRateLimiter({ windowMs: 15 * 60 * 1000, max: 5, now: () => now });
    for (let i = 0; i < 5; i++) assert.equal(allow('tenant-a'), true);
    assert.equal(allow('tenant-a'), false);
    assert.equal(allow('tenant-b'), true);
    now += 15 * 60 * 1000;
    assert.equal(allow('tenant-a'), true);
  });
});

describe('safeErrorMessage', () => {
  it('removes connection strings, access keys and passwords', () => {
    const msg = safeErrorMessage(
      new Error(`auth failed ${CONNECTION} accesskey=another-secret pass=app-password-value smtp=${CENTRAL_PASSWORD}`),
      ['app-password-value', CONNECTION, CENTRAL_PASSWORD]
    );
    assert.equal(msg.includes('super-secret-value'), false);
    assert.equal(msg.includes('another-secret'), false);
    assert.equal(msg.includes('app-password-value'), false);
    assert.equal(msg.includes(CENTRAL_PASSWORD), false);
    assert.match(msg, /auth failed/);
  });
});
