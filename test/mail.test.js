const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMailService, applySettingsPatch, crossedCriticalThreshold } = require('../mail');

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
        sendMail: async (msg) => { bag.sent.push({ opts, msg }); }
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

function service({ env = {}, nodemailerBag, acsBag } = {}) {
  return createMailService({
    env,
    nodemailer: fakeNodemailer(nodemailerBag || { sent: [], transports: [] }),
    createEmailClient: fakeAcs(acsBag || { connections: [], payloads: [] })
  });
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

  it('exposes only the smtpCentral boolean and never the secret', () => {
    const mail = service({ env: acsEnv({ EMAIL_REPLY_TO: 'info@scanny.se' }) });
    const pub = mail.publicSettings({ email: 'chef@verkstad.se', smtpUser: '', smtpPass: 'stored-pass', smtpHost: 'smtp.gmail.com' });
    assert.equal(pub.smtpPass, undefined);
    assert.equal(pub.smtpCentral, true);
    assert.equal(typeof pub.smtpCentral, 'boolean');
    assert.equal(JSON.stringify(pub).includes('super-secret-value'), false);
    assert.equal(JSON.stringify(pub).includes('accesskey'), false);
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
});
