// Checks that every string passed to l10n.t() (or the `t` alias) has a translation in
// each l10n/bundle.l10n.<lang>.json, with the same {0} placeholders.
//   node scripts/check-l10n.js          -> check
//   node scripts/check-l10n.js --keys   -> print every key as JSON (to start a new language)
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const srcDir = path.join(root, 'src');
const l10nDir = path.join(root, 'l10n');
const call = /(?:\bl10n\.t|\bt)\(\s*('(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*")/g;

const keys = new Set();
for (const file of fs.readdirSync(srcDir).filter((f) => f.endsWith('.ts'))) {
  const text = fs.readFileSync(path.join(srcDir, file), 'utf8');
  for (const m of text.matchAll(call)) {
    keys.add(new Function(`return ${m[1]}`)());
  }
}

if (process.argv.includes('--keys')) {
  console.log(JSON.stringify(Object.fromEntries([...keys].sort().map((k) => [k, k])), null, 2));
  process.exit(0);
}

const placeholders = (s) => (s.match(/\{\d+\}/g) || []).sort().join(',');
let failed = false;
for (const file of fs.readdirSync(l10nDir).filter((f) => /^bundle\.l10n\..+\.json$/.test(f))) {
  const bundle = JSON.parse(fs.readFileSync(path.join(l10nDir, file), 'utf8'));
  const missing = [...keys].filter((k) => !(k in bundle));
  const unused = Object.keys(bundle).filter((k) => !keys.has(k));
  const badArgs = [...keys].filter((k) => k in bundle && placeholders(k) !== placeholders(bundle[k]));
  console.log(`${file}: ${keys.size} keys, ${missing.length} missing, ${unused.length} unused, ${badArgs.length} placeholder mismatches`);
  missing.forEach((k) => console.log('  missing:', JSON.stringify(k)));
  unused.forEach((k) => console.log('  unused: ', JSON.stringify(k)));
  badArgs.forEach((k) => console.log('  args:   ', JSON.stringify(k)));
  if (missing.length || badArgs.length) failed = true;
}
process.exit(failed ? 1 : 0);
