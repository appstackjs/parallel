const EventEmitter = require("events");
const cluster = require("cluster");
const os = require("os");
const path = require("path");
const { performance } = require("perf_hooks");

const MessageType = require("../message-type.js");
const SysCall = require("../syscall.js");

const SegmentInterface = require("./segment-interface.js");

// Safeguard for NodeJS@<16.0.0
if (parseInt(process.versions.node.split(".")[0]) < 16) {
  cluster.isPrimary = cluster.isMaster;
  cluster.setupPrimary = cluster.setupMaster;
}

const kSegmentInfo = Symbol("kSegmentInfo");

SegmentInterface._hasSegmentInfoSymbol(kSegmentInfo);

function now() {
  return performance.now() + performance.timeOrigin;
}

let segment_config;

class ApplicationController extends EventEmitter {
  #launch_config;
  #target_segments;
  #restart_config;

  #segments;

  #daemon_services;
  
  constructor(opts) {
    super();

    if (!cluster.isPrimary) {
      throw new Error("[appstack/parallel] Cannot instantiate ApplicationController inside segment.");
    }

    opts = {
      segments: os.cpus().length*2,
      file: null,
      args: [],
      env: process.env,
      uid: process.geteuid(),
      gid: process.getegid(),
      daemon_services: [],
      restart: {},
      ...segment_config,
      ...opts
    };

    opts.restart = {
      signal: true,
      code: true,
      normal: true,
      min_age: 5000,
      ...opts.restart
    };

    this.#restart_config = opts.restart;

    if (opts.file === null || (opts.file === "")) {
      throw new Error("[appstack/parallel] Cannot instantiate ApplicationController without passing `file` to run segments in.");
    } else {
      if (typeof opts.file !== "string" && opts.file.constructor !== String) {
        throw new Error("[appstack/parallel] ApplicationController `file` option expected to be a string.");
      }

      if (opts.file[0] !== "/") {
        // Must resolve path relative to the caller's file.
        let trace = new Error().stack.split("\n")[3].match(/\(([^:]+):[0-9]+:[0-9]+\)/)[1].split("/");
        trace.pop(); trace = trace.join("/");
        opts.file = path.resolve(trace, opts.file);
      }

      // opts.file is now guaranteed to be a string of non-zero length
      // containing an absolute path.
    }

    if (opts.segments <= 0) {
      throw new Error("[appstack/parallel] ApplicationController `segments` option must be positive. (got " + opts.segments + ")");
    }

    this.#target_segments = opts.segments;
    this.#launch_config = {
      file: opts.file,
      args: opts.args,
      env: opts.env,
      uid: opts.uid,
      gid: opts.gid
    };

    this.#segments = {};

    this.#daemon_services = {};
    for (let service of opts.daemon_services) {
      this.#daemon_services[service.key] = service;
    }

    process.on("message", this.#onBootProcessMessage.bind(this));
  }

  attach(service) {
    this.#daemon_services[service.key] = service;
    
    // Notify each SegmentInterface instance of the new service.
    for (let id in this.#segments) {
      this.#segments[id][kSegmentInfo].iface.attach(service);
    }

    return this;
  }

  _start() {
    this.refresh_segments();
  }

  refresh_segments() {
    let required_segments = this.#target_segments - Object.keys(this.#segments).length;

    for (let i = 0; i < required_segments; ++i) {
      this.launch({});
    }
  }

  launch(config) {
    config = {
      ...this.#launch_config,
      ...config
    };

    cluster.setupPrimary({
      exec: path.resolve(__dirname, "../segment-boot.js"),
      args: config.args,
      serialization: "advanced",
      stdio: [0, 1, 2, 'ipc'],
      uid: config.uid,
      gid: config.gid,
      windowsHide: true
    });
    
    let id = Buffer.from(Array.from(new Uint8Array(16)).map(x =>
      Math.floor(Math.random()*256)
    )).toString("hex");

    let worker = cluster.fork({
      ...config.env,
      __APPSTACK_SEGMENT_ID: id,
      __APPSTACK_SEGMENT_EXEC: config.file
    });

    let workerBirth = now();

    worker[kSegmentInfo] = {
      SEGMENT_ID: id,
      times: {
        launch: workerBirth,
        online: null,
        responsive: null,
        dead: null
      },
      iface: new SegmentInterface(worker, id, this, this.#daemon_services),
    };

    this.#segments[id] = worker;

    this.emit("launch", worker[kSegmentInfo].iface, id);
    
    return worker[kSegmentInfo].iface;
  }

  _restartWorker(iface, code, signal) {
    let config = this.#launch_config;
    
    cluster.setupPrimary({
      exec: path.resolve(__dirname, "../segment-boot.js"),
      args: config.args,
      serialization: "advanced",
      stdio: [0, 1, 2, 'ipc', 3],  // fd 3 is an IPC pipe to the bootload process
      uid: config.uid,
      gid: config.gid,
      windowsHide: true
    });

    let id = Buffer.from(new Array(16, 0).map(x =>
      Math.floor(Math.random()*256)
    )).toString("hex");

    let worker = cluster.fork({
      ...config.env,
      __APPSTACK_SEGMENT_ID: id,
      __APPSTACK_SEGMENT_EXEC: config.file
    });

    let workerBirth = now();

    worker[kSegmentInfo] = {
      SEGMENT_ID: id,
      times: {
        launch: workerBirth,
        online: null,
        responsive: null,
        dead: null
      },
      iface,
    };

    worker[kSegmentInfo].iface._update(worker, id);

    this.#segments[id] = worker;

    worker[kSegmentInfo].iface.emit("restart", code, signal);

    return id;
  }

  getSegmentById(id) {
    if (!(id in this.#segments)) return null;
    return this.#segments[id][kSegmentInfo].iface;
  }

  getSegmentIds() {
    return Object.keys(this.#segments);
  }

  forEach(callback) {
    if (callback === null || callback === undefined || (callback !== null &&
        callback !== undefined && callback.constructor !== Function)) {
      throw new Error("Expected function for argument 1 of appstack.parallel.ApplicationController.forEach.");
    }

    for (let key in this.#segments) {
      callback(this.#segments[key][kSegmentInfo].iface, key);
    }

    return this;
  }

  syscall(call, data, cb) {
    process.send({
      type: MessageType.SYSTEM,
      call,
      time: now(),
      pid: process.pid,
      ...data
    }, cb);

    return this;
  }

  statistic(realm, data, cb) {
    this.syscall(SysCall.STAT, {
      realm,
      message: data
    }, cb);

    return this;
  }

  close(code, reason, cb) {
    this.syscall(SysCall.CLOSE, {
      code, reason
    }, ()=>{
      cb();
    });
  }

  _getRestartConfig() {
    return this.#restart_config;
  }

  _workerDeath(code, signal, iface) {
    delete this.#segments[iface.id];
  }

  _reconsiderShutdown() {
    if (Object.keys(this.#segments).length === 0) this.#shutdown();
  }

  #onBootProcessMessage(message) {
    if (message.type === MessageType.SYSTEM) {
      this.#onBootProcessSystemMessage(message);
    }
  }

  #onBootProcessSystemMessage(message) {
    switch (message.call) {
    case SysCall.CLOSE:
      // BootProcess is closing.
      this.#shutdown(message.code, message.reason);
      break;
    }
  }

  #shutdown(code, reason) {
    console.error("Shutdown application");
    // Checklist:
    // 1. Order for the death of all segments.
    // 2. Run "exit" event hooks
    // 3. Close the process.
    
    // Step 1: Order for the death of all segments. (And wait for their light to
    // fade)
    let number_dead = 0, target_dead = Object.keys(this.#segments).length;

    if (target_dead === 0) {
      // Step 1 can be bypassed.
      // Step 2: Run "exit" event hooks
      this.on("exit", ()=>{
        // Step 3: Close the process.
        process.exit(code);
      });

      this.emit("exit", code, reason);
    }

    for (let id in this.#segments) {
      this.#segments[id][kSegmentInfo].iface.on("eol", ()=>{
        ++number_dead;

        if (number_dead === target_dead) {
          // Step 2: Run "exit" event hooks
          this.on("exit", ()=>{
            // Step 3: Close the process.
            process.exit(code);
          });

          this.emit("exit", code, reason);
        }
      });

      this.#segments[id][kSegmentInfo].iface.close(code, reason);
    }
  }
}

ApplicationController._segment_config = function(c) {
  segment_config = c;
}

module.exports = ApplicationController;

