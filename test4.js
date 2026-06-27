const fs = require('fs');
const log = (s) => fs.appendFileSync('test4.txt', String(s) + '\n');
fs.writeFileSync('test4.txt', '');
log('type: ' + process.type);
try {
  const binding = process._linkedBinding('electron_browser_app');
  log('binding keys: ' + Object.keys(binding||{}).join(', '));
} catch(e) { log('binding error: ' + e.message); }
try {
  const binding2 = process._linkedBinding('electron_common_features');
  log('features keys: ' + Object.keys(binding2||{}).slice(0,5).join(', '));
} catch(e) { log('features error: ' + e.message); }
