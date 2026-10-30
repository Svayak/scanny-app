const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const pages = ['public/admin.html', 'index.html'];

function read(rel) {
  return fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
}

describe('settings UI for lagerlarm', () => {
  for (const page of pages) {
    it(`${page} shows the recipient field and hides SMTP until requested`, () => {
      const html = read(page);
      assert.match(html, /E-post för lagerlarm/);
      assert.match(html, /Hit skickas kritiska lagerlarm\. Beställningar och inventeringsrapporter skickas till chefens e-post\./);
      assert.match(html, /Hit skickas beställningar och inventeringsrapporter\./);
      assert.equal(html.includes('Används för beställningar och inventeringsrapporter.'), false);
      assert.match(html, /id="s-alert-email"/);
      assert.match(html, /Skicka testmejl/);
      assert.match(html, /Ändra avsändaradress/);
      assert.match(html, /Mejl skickas från noreply@altitudmedia\.se\. Vill du skicka från en egen adress kan du ange SMTP-uppgifter\./);

      const marker = 'id="smtp-fields" hidden';
      const start = html.indexOf(marker);
      assert.notEqual(start, -1);
      const block = html.slice(start, html.indexOf('</div>', html.indexOf('id="s-pass"', start)) + 6);
      for (const id of ['s-host', 's-port', 's-user', 's-pass']) {
        assert.equal(block.includes(`id="${id}"`), true, `${id} ska ligga i det dolda SMTP-blocket`);
      }
      assert.equal(html.slice(0, start).includes('id="s-host"'), false);
    });
  }

  it('opens custom SMTP when a username is already stored and posts the alert field', () => {
    const js = read('public/js/app.js');
    assert.match(js, /function toggleSmtpFields\(/);
    assert.match(js, /setSmtpFieldsOpen\(!!String\(s\.smtpUser \|\| ''\)\.trim\(\)\)/);
    assert.match(js, /body\.alertEmail/);
    assert.match(js, /Hit skickas kritiska lagerlarm\. Beställningar och inventeringsrapporter skickas till chefens e-post\./);
    assert.match(js, /\/api\/settings\/test-alert/);
    assert.match(js, /Testmejl skickat \(\$\{res\.channel\}\)/);
    assert.match(js, /smtpHost:\s+document\.getElementById\('s-host'\)\.value\.trim\(\)/);
    assert.match(js, /if \(pass\) body\.smtpPass = pass/);
  });
});
