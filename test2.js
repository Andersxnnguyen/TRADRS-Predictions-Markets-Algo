const Module = require('module');
console.log("builtins has electron:", Module.builtinModules.includes('electron'));
console.log("process.type:", process.type);
console.log("process.versions.electron:", process.versions.electron);

// Check Module._load patch
const orig = Module._load;
Module._load = function(req, ...args) {
  if (req === 'electron') console.log("_load intercepted 'electron'");
  return orig.call(this, req, ...args);
};

const e = require('electron');
console.log("result type:", typeof e);
