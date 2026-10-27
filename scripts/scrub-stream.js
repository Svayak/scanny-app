#!/usr/bin/env node
// Skriver en redan sparad kommandologg till stderr utan anslutningssträngar.
// Avslutar med samma kod som kommandot (argv: fil, exitkod).
const fs = require('fs');
const { redactText } = require('../redact');

const file = process.argv[2];
const code = Number(process.argv[3] || 0);
const known = [process.env.MONGODB_URI, process.env.AZURE_STORAGE_CONNECTION_STRING, process.env.ACS_EMAIL_CONNECTION_STRING]
  .filter(Boolean);
let msg = '';
try {
  msg = file ? fs.readFileSync(file, 'utf8') : fs.readFileSync(0, 'utf8');
} catch {
  msg = '';
}
process.stderr.write(redactText(msg, known));
process.exit(Number.isFinite(code) ? code : 1);
