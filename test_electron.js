const e = require("electron");
console.log("type:", typeof e);
console.log("val:", typeof e === "string" ? e : Object.keys(e).join(", "));
