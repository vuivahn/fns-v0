"use strict";

class RelayError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.detail = detail;
  }
}

class RelayProtocolError extends RelayError {
  constructor(message, detail = null) {
    super("E_RELAY_PROTOCOL", message, detail);
  }
}

class RelayLimitError extends RelayError {
  constructor(message, detail = null) {
    super("E_RELAY_LIMIT", message, detail);
  }
}

class RelayAuthenticationError extends RelayError {
  constructor(message, detail = null) {
    super("E_RELAY_AUTHENTICATION", message, detail);
  }
}

class RelayAdmissionError extends RelayError {
  constructor(message, detail = null) {
    super("E_RELAY_ADMISSION", message, detail);
  }
}

module.exports = { RelayAdmissionError, RelayAuthenticationError, RelayError, RelayLimitError, RelayProtocolError };
