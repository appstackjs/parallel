const EventEmitter = require("events");
const { performance } = require("perf_hooks");

const MessageType = require("../message-type.js");
const SysCall = require("../syscall.js");

function now() {
  return performance.now() + performance.timeOrigin;
}

class Segment extends EventEmitter {
  #daemon_interfaces;

  constructor() {
    super();
    
    this.#daemon_interfaces = {};

    process.on("message", this.#onMessage.bind(this));
  }

  attach(daemon) {
    this.#daemon_interfaces[daemon.key] = daemon._internals(this);
  }

  send(message, callback) {
    this.#send(MessageType.APPLICATION, {
      message
    }, callback);
  }

  _sendDaemon(message, key, callback) {
    this.#send(MessageType.DAEMON, {
      message,
      daemon_key: key
    }, callback);
  }

  syscall(call, message, callback) {
    this.#send(MessageType.SYSTEM, {
      call,
      message
    }, callback);
  }

  exit(code=0, reason="no reason provided", callback) {
    this.syscall(SysCall.CLOSE, {
      code, reason
    }, callback);
    
    this.on("exit", process.exit);
    this.emit("exit", code, reason);
  }

  statistic(realm, data, cb) {
    // Send statistic data up the pipeline. It doesn't get logged here.
    this.#send(MessageType.SYSTEM, {
      call: SysCall.STAT,
      realm,
      message: data
    }, cb);
  }

  #send(level, message, callback) {
    process.send({
      type: level,
      time: now(),
      pid: process.pid,
      ...message
    }, callback);
  }

  #onMessage(message) {
    if (message.type === MessageType.SYSTEM) {
      this.#onSystemMessage(message);
    } else if (message.type === MessageType.DAEMON) {
      this.#daemon_interfaces[message.daemon_key].message(message);
    } else if (message.type === MessageType.APPLICATION) {
      this.emit("message", {
        message: message.message,
        time: message.time,
        pid: message.pid
      });
    }
  }

  #onSystemMessage(message) {
    switch (message.call) {
    case SysCall.CLOSE:
      // Primary telling this segment to end.
      this.on("exit", process.exit);
      this.emit("exit", message.code, message.reason);
      break;
    }
  }
}

module.exports = Segment;

