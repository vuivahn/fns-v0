"use strict";

class StoreError extends Error {
  constructor(code, message, detail = null) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    this.detail = detail;
  }
}

class InvalidRequestError extends StoreError {
  constructor(message, detail = null) { super("E_STORE_INVALID_REQUEST", message, detail); }
}

class StoreAccessError extends StoreError {
  constructor(message, detail = null) { super("E_STORE_ACCESS", message, detail); }
}

class StoreIntegrityError extends StoreError {
  constructor(message, detail = null) { super("E_STORE_INTEGRITY", message, detail); }
}

module.exports = { StoreError, InvalidRequestError, StoreAccessError, StoreIntegrityError };
