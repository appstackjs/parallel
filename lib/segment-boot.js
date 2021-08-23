const { performance } = require("perf_hooks");
const LAUNCH_TIME = performance.timeOrigin;

const ID = process.env.__APPSTACK_SEGMENT_ID;
const EXEC = process.env.__APPSTACK_SEGMENT_EXEC;

let Segment = require("./segment/default.js");
let s = new Segment();

let main = require(EXEC);
main(s);

