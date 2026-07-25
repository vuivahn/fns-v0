"use strict";

const { MemoryStore } = require("./memory-store");
const { SCHEMA_VERSION, SQLiteStore, SQLiteStoreAdmin } = require("./sqlite-store");
const { FnsStore } = require("./fns-store");
const { InvalidRequestError, StoreAccessError, StoreIntegrityError } = require("./errors");
const { discoverFromStore, resolveAliasFromStore } = require("./adapter");

module.exports = {
  FnsStore,
  MemoryStore,
  SCHEMA_VERSION,
  SQLiteStore,
  SQLiteStoreAdmin,
  InvalidRequestError,
  StoreAccessError,
  StoreIntegrityError,
  discoverFromStore,
  resolveAliasFromStore
};
