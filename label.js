// ══════════════════════════════════════════════════════════════
//  label.js — Etikettgenerering + utskrift till Brother QL-810W
//  Genererar en PNG med produktnamn + streckkod (Code128) och
//  skickar den till skrivaren över nätverket via brother_ql.
//
//  Kräver:
//    npm i bwip-js sharp
//    pip install brother_ql   (på servern, ger CLI:t "brother_ql")
// ══════════════════════════════════════════════════════════════
const bwipjs = require('bwip-js');
const sharp  = require('sharp');
const { spawn } = require('child_process');
const os   = require('os');
const path = require('path');
const fs   = require('fs');

// Printbar bredd/höjd i punkter (300 dpi) för vanliga DK-rullar.
// Lägg till fler vid behov. w = bredd på tejpen, h = längd per etikett.
const LABEL_DIMS = {
  '62':    { w: 696, h: 280 },  // DK-22205  kontinuerlig 62 mm  (standard i kartongen)
  '29':    { w: 306, h: 280 },  // DK-22210  kontinuerlig 29 mm
  '38':    { w: 413, h: 280 },  // DK-22225  kontinuerlig 38 mm
  '50':    { w: 554, h: 280 },  // kontinuerlig 50 mm
  '54':    { w: 590, h: 280 },  // DK-N55224 kontinuerlig 54 mm
  '62x29': { w: 696, h: 271 },  // DK-11209/liknande stansad 62 x 29 mm (bra produktetikett)
  '29x90': { w: 991, h: 306 },  // DK-11201  stansad adress 29 x 90 mm (liggande)
};

function escXml(s) {
  return String(s || '').replace(/[<>&'"]/g, c =>
    ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

// Enkel radbrytning av produktnamn på max ~2 rader.
function wrapName(name, maxChars) {
  const words = String(name || '').split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if ((cur + ' ' + w).trim().length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = (cur + ' ' + w).trim();
    if (lines.length === 2) break;
  }
  if (cur && lines.length < 2) lines.push(cur);
  if (lines.length === 2 && cur !== lines[1]) lines[1] += '…';
  return lines.slice(0, 2);
}

// Genererar etiketten som PNG-buffer.
async function generateLabelPng(product, labelSize = '62') {
  const dim = LABEL_DIMS[labelSize] || LABEL_DIMS['62'];
  const W = dim.w, H = dim.h;

  // Streckkod (Code128) → PNG → base64, bäddas in i SVG.
  const barcodePng = await bwipjs.toBuffer({
    bcid: 'code128',
    text: String(product.code || ''),
    scale: 3,
    height: 14,          // mm-relativ höjd på streckkoden
    includetext: true,   // skriver ut koden i klartext under streckkoden
    textxalign: 'center',
    textsize: 11,
  });
  const barcodeUri = 'data:image/png;base64,' + barcodePng.toString('base64');

  const maxChars = Math.max(12, Math.floor(W / 22));
  const nameLines = wrapName(product.name, maxChars);
  const nameSvg = nameLines.map((ln, i) =>
    `<text x="${W / 2}" y="${44 + i * 40}" text-anchor="middle" ` +
    `font-family="Arial, Helvetica, sans-serif" font-size="36" font-weight="700" ` +
    `fill="#000">${escXml(ln)}</text>`).join('');

  const artY = 44 + nameLines.length * 40 + 4;
  const artSvg = product.articleNo
    ? `<text x="${W / 2}" y="${artY}" text-anchor="middle" ` +
      `font-family="Arial, Helvetica, sans-serif" font-size="22" fill="#333">` +
      `Art.nr: ${escXml(product.articleNo)}</text>`
    : '';

  // Streckkoden fyller nedre delen av etiketten.
  const bcTop = artY + (product.articleNo ? 12 : 0);
  const bcH   = H - bcTop - 12;
  const bcW   = W - 56;

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">
  <rect width="${W}" height="${H}" fill="#fff"/>
  ${nameSvg}
  ${artSvg}
  <image x="28" y="${bcTop}" width="${bcW}" height="${bcH}"
         preserveAspectRatio="xMidYMid meet" href="${barcodeUri}"/>
</svg>`;

  return sharp(Buffer.from(svg)).png().toBuffer();
}

// Skriver ut etiketten via brother_ql över nätverket.
// labelSize (vår interna storlek) → CUPS PageSize-namn i Brothers drivrutin.
const CUPS_PAGESIZE = {
  '62': '62mm', '29': '29mm', '38': '38mm', '50': '50mm', '54': '54mm',
  '62x29': 'DC06', // stansad 62 x 29 mm
  '29x90': 'DC03', // stansad 29 x 90 mm (adress)
};

// Skriver ut etiketten via macOS utskriftssystem (CUPS) med Brothers drivrutin.
// Detta är den beprövade vägen på verkstadens Mac: `lp -d <kö> -o PageSize=<storlek> fil.png`.
function printLabel(product, settings) {
  const labelSize = settings.labelSize || '62';
  const queue     = settings.printerQueue || '_192_168_10_164';
  const pageSize  = settings.pageSize || CUPS_PAGESIZE[labelSize] || '62mm';

  return generateLabelPng(product, labelSize).then(png => new Promise((resolve, reject) => {
    const tmp = path.join(os.tmpdir(), `scanny-label-${Date.now()}.png`);
    fs.writeFileSync(tmp, png);

    const args = ['-d', queue, '-o', `PageSize=${pageSize}`, '-o', 'fit-to-page', tmp];
    const proc = spawn('lp', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('error', err => {
      fs.unlink(tmp, () => {});
      if (err.code === 'ENOENT')
        reject(new Error('Kommandot "lp" hittades inte — kör Scanny på Macen med Brother-skrivaren installerad.'));
      else reject(err);
    });
    proc.on('close', code => {
      fs.unlink(tmp, () => {});
      if (code === 0) resolve({ ok: true });
      else reject(new Error('Utskrift misslyckades: ' + (stderr.trim() || `lp avslutades med kod ${code}`)));
    });
  }));
}

module.exports = { generateLabelPng, printLabel, LABEL_DIMS };
