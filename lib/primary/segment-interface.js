const EventEmitter = require("events");
const { performance } = require("perf_hooks");

const MessageType = require("../message-type.js");
const SysCall = require("../syscall.js");

let kSegmentInfo = null;

const FLAG_INTENTIONAL_CLOSE = 0b00000000000000000000000000000001;

function now() {
  return performance.now() + performance.timeOrigin;
}

/**
 * Write-end interface for transmission to segment processes from the primary
 * application process, and read-end interface for reception of data from
 * segment processes.
 */
class SegmentInterface extends EventEmitter {
  #worker;
  #id;
  #controller;
  
  #daemon_services;

  #flags;

  constructor(worker, id, controller, daemons={}) {
    super();

    this.#worker = worker;
    this.#id = id;
    this.#controller = controller;
    this.#flags = 0;

    this.#daemon_services = daemons;
    
    this.#worker.once("online", this.#onWorkerOnline.bind(this))
    this.#worker.on("message", this.#onWorkerMessage.bind(this));
    this.#worker.once("disconnect", this.#onWorkerDisconnect.bind(this));
    this.#worker.once("exit", this.#onWorkerExit.bind(this));
  }

  get id() {
    return this.#id;
  }

  get controller() {
    return this.#controller;
  }

  attach(service) {
    this.#daemon_services[service.key] = service;
  }

  send(message, cb) {
    this.#worker.send({
      type: MessageType.APPLICATION,
      time: now(),
      pid: process.pid,
      message
    }, cb);
  }

  syscall(call, message, cb) {
    this.#worker.send({
      type: MessageType.SYSTEM,
      time: now(),
      pid: process.pid,
      call,
      message
    }, cb);
  }

  close(code=0, reason="", cb) {
    this.syscall(SysCall.CLOSE, {
      code,
      reason
    }, cb);

    this.#flags |= FLAG_INTENTIONAL_CLOSE;
  }

  statistic(realm, data, cb) {
    this.#controller.statistic(realm, data, cb);
  }

  _sendDaemon(message, key, cb) {
    this.#worker.send({
      type: MessageType.DAEMON,
      time: now(),
      pid: process.pid,
      daemon_key: key,
      message
    }, cb);
  }

  #onWorkerOnline() {
    this.#worker[kSegmentInfo].times.online = now();

    for (let key in this.#daemon_services) {
      this.#daemon_services[key].online(this);
    }
  }

  #onWorkerMessage(message) {
    if (message.type === MessageType.SYSTEM) {
      this.#onSystemMessage(message);
    } else if (message.type === MessageType.DAEMON) {
      this.#daemon_services[message.daemon_key].message(this, message.message);
    } else if (message.type === MessageType.APPLICATION) {
      this.emit("message", message.message);
    }
  }

  #onSystemMessage(message) {
    switch (message.call) {
    case SysCall.CLOSE:
      // Segment is notifying the application process of intentional closure.
      this.emit("close", message.message.code||0, message.message.reason||"");
      this.#flags |= FLAG_INTENTIONAL_CLOSE;
      break;
    case SysCall.STAT:
      // Segment has a statistic payload to send up the pipeline
      process.send(message);
      break;
    }
  }

  #onWorkerDisconnect() {
    if (this.#worker.isDead()) return;
    
    // When the IPC channel between us and the worker is severed, there is only
    // one thing left to do; ensure its demise, and then restart it.
    this.#worker.kill("SIGHUP");

    let t = setTimeout(()=>{
      if (!this.#worker.isDead()) {
        // Worker is still alive.
        this.#worker.kill("SIGKILL");
      }
    }, 5000);

    this.#worker.once("exit", ()=>clearInterval(t));
  }

  #onWorkerExit(code, signal) {
    this.#worker[kSegmentInfo].times.dead = now();
    let age = (this.#worker[kSegmentInfo].times.dead -
               this.#worker[kSegmentInfo].times.online);
    
    this.emit("death", code, signal);
    this.#worker.removeAllListeners();
    this.#controller._workerDeath(code, signal, this);
    // The ApplicationController instance deletes the worker for its store at
    // this point, and, given the complicated nature of object references in
    // JavaScript, I'm just going to say that using this.#worker after this
    // point will not end well.

    let restart_rules = this.#controller._getRestartConfig();
    
    age = Number(age);
    
    if (!(this.#flags & FLAG_INTENTIONAL_CLOSE) &&
        age >= restart_rules.min_age) {
      // Segment is eligible for restart.
      if (restart_rules.signal && signal) {
        // Segment was killed by a signal and should be restarted.
        this.#controller._restartWorker(this, code, signal);
      } else if (restart_rules.code && code !== 0) {
        // Segment terminated with an error code.
        this.#controller._restartWorker(this, code, signal);
      } else if (restart_rules.normal && code === 0) {
        // Segment terminated normally, but without stating that it would do so
        // intentionally.
        this.#controller._restartWorker(this, code, signal);
      } else {
        // Segment should not be restarted.
        this.emit("eol", code, signal);
        this.removeAllListeners();  // Prevent memleaks in poorly written code.
        this.#controller._reconsiderShutdown();
      }
    } else {
      // Segment is not eligible for restart, either because close was
      // intentional or because the process was too young.
      this.emit("eol", code, signal);
      this.removeAllListeners();  // Prevent memleaks in poorly written code.
      this.#controller._reconsiderShutdown();
    }
  }

  _update(worker, id) {
    this.#id = id;
    this.#worker = worker;
    this.#flags = 0;
    
    this.#worker.once("online", this.#onWorkerOnline.bind(this))
    this.#worker.on("message", this.#onWorkerMessage.bind(this));
    this.#worker.once("disconnect", this.#onWorkerDisconnect.bind(this));
    this.#worker.once("exit", this.#onWorkerExit.bind(this));
  }
}

SegmentInterface._hasSegmentInfoSymbol = function(s) {
  kSegmentInfo = s;
}

module.exports = SegmentInterface;

