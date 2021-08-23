const { performance } = require("perf_hooks");
const LAUNCH_TIME = performance.timeOrigin;
const v8 = require("v8");

const ApplicationController = require("./primary/controller.js");

ApplicationController._segment_config(v8.deserialize(Buffer.from(process.env.__APPSTACK_SEGMENT_CONFIG, "hex")));

let main = require(process.env.__APPSTACK_BOOT_MAIN_SCRIPT);

function createController(opts) {
  return new ApplicationController(opts);
}

function controllerReady(c) {
  c._start();
}

let controller = main(createController);

if (controller == undefined) {
  console.error("error: function " + (main.name?main.name:"<anonymous>") + " (" + process.env.__APPSTACK_BOOT_MAIN_SCRIPT + ") did not return a controller.");
  process.exit(1);
} else if (controller.contructor === Promise) {
  controller.then(x => controllerReady(x)).catch(err => {
    console.error("error: async function " + (main.name?main.name:"<anonymous>") + " (" + process.env.__APPSTACK_BOOT_MAIN_SCRIPT + ") rejected with:");
    console.error(err);
    process.exit(1);
  });
} else {
  controllerReady(controller);
}

