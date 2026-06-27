const fs = require('fs');
const Module = require('module');
const log = (s) => fs.appendFileSync('C:/Users/danbe/Downloads/kalshi-trader-app/kalshi-trader-app/test3.txt', s + '\n');

fs.writeFileSync('C:/Users/danbe/Downloads/kalshi-trader-app/kalshi-trader-app/test3.txt', '');

log('process.type: ' + process.type);
log('resolve electron: ' + require.resolve('electron'));

// Patch _resolveFilename to see what Electron intercepts
const origResolve = Module._resolveFilename.bind(Module);
Module._resolveFilename = function(req, ...args) {
  const result = origResolve(req, ...args);
  if (req === 'electron') log('_resolveFilename electron -> ' + result);
  return result;
};

const e = require('electron');
log('typeof e: ' + typeof e);
log('e value: ' + (typeof e === 'string' ? e.slice(-30) : JSON.stringify(Object.keys(e||{}).slice(0,5))));
