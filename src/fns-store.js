"use strict";

class FnsStore {
  async getObject() { throw new TypeError("FnsStore#getObject must be implemented"); }
  async findAliasBindings() { throw new TypeError("FnsStore#findAliasBindings must be implemented"); }
  async findAliasReleases() { throw new TypeError("FnsStore#findAliasReleases must be implemented"); }
  async findCommuneDocuments() { throw new TypeError("FnsStore#findCommuneDocuments must be implemented"); }
}

module.exports = { FnsStore };
