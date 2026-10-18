// Both deliveries use the current calendar/timer core; only the UI adapter differs.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let source = fs.readFileSync(path.join(root, '../BetterBitrix.user.js'), 'utf8');
const end = source.indexOf('  function refresh() {');
if (end < 0 || !source.includes('window.__b24EightHoursInstalled')) throw Error('Unexpected upstream snapshot');
source = source.slice(0, end).replaceAll('__b24EightHoursInstalled', '__betterBitrixDesktopInstalled');
source = source.replace('      const date=context.date, key=', '      desktopCalendarContext=context;\n      const date=context.date, key=');
const adapter = fs.readFileSync(path.join(root, 'extension/adapter.js'), 'utf8');
fs.writeFileSync(path.join(root, 'extension/runtime.js'), source + adapter);
const header = fs.readFileSync(path.join(root, 'companion/header.txt'), 'utf8');
fs.writeFileSync(path.join(root, 'companion/BetterBitrixPortable.meta.js'), header);
const transport = fs.readFileSync(path.join(root, 'companion/transport.js'), 'utf8');
// The page runtime must share the original userscript's raw realm (including on Firefox).
// Firefox's JavaScript sandbox requires exported functions before replacing page APIs.
// GM credentials remain private to the userscript scope, rather than page storage.
const body = (source + adapter).slice((source + adapter).indexOf('(() => {'));
const aliases = 'const window=unsafeWindow, XMLHttpRequest=window.XMLHttpRequest, navigator=window.navigator;';
fs.writeFileSync(path.join(root, 'companion/BetterBitrixPortable.user.js'), `${header}\n(() => {\n${aliases}\n${body}\n${transport}\n})();\n`);
