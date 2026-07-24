"use strict";

const { MemoryStore } = require("./memory-store");
const { FnsStore } = require("./fns-store");
const { InvalidRequestError, StoreAccessError, StoreIntegrityError } = require("./errors");
const { discoverFromStore, resolveAliasFromStore } = require("./adapter");

module.exports = { FnsStore, MemoryStore, InvalidRequestError, StoreAccessError, StoreIntegrityError, discoverFromStore, resolveAliasFromStore };
