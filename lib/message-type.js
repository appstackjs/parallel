module.exports = Object.freeze({
  /**
   * Self-explanatory. Denotes system message calls between processes.
   */
  SYSTEM:      "appstack.parallel.MessageType.SYSTEM",

  /**
   * Denotes namespaced messages coming from daemon facilities for logging,
   * rendering, machine learning, etc.
   */
  DAEMON:      "appstack.parallel.MessageType.DAEMON",

  /**
   * Denotes simple application messages that the developer may build their own
   * communication protocol on top of. Receipt of these messages does not change
   * the internal state of AppStack.
   */
  APPLICATION: "appstack.parallel.MessageType.APPLICATION",
});

