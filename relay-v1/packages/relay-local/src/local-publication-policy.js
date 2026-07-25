"use strict";

const { RelayAdmissionError, RelayProtocolError } = require("../../relay-contract/src/errors");
const { normalizeCandidates } = require("../../relay-contract/src/validation");

const PUBLISH_SCOPE = "relay:publication:create";

function contextFor(candidate) {
  const payload = candidate.object?.payload;
  if (payload?.type === "fns.alias.bind" && typeof payload.context === "string") return payload.context;
  if (payload?.type === "fns.commune.update" && typeof payload.commune === "string") return payload.commune;
  return null;
}

function isCandidateScopeGranted(scopes, candidate) {
  if (scopes.includes(PUBLISH_SCOPE)) return true;
  if (scopes.includes(`${PUBLISH_SCOPE}:object:${candidate.objectId}`)) return true;
  const context = contextFor(candidate);
  return context !== null && scopes.includes(`${PUBLISH_SCOPE}:context:${context}`);
}

class LocalPublicationPolicy {
  constructor({ evaluate = null } = {}) {
    if (evaluate !== null && typeof evaluate !== "function")
      throw new RelayProtocolError("evaluate must be a function or null");
    this.evaluate = evaluate;
  }

  async admit({ capability, candidates, request = null }) {
    if (!capability || !Array.isArray(capability.scopes))
      throw new RelayAdmissionError("publication requires a verified Relay-local capability");
    const normalized = normalizeCandidates(candidates);
    if (!normalized.every((candidate) => isCandidateScopeGranted(capability.scopes, candidate)))
      throw new RelayAdmissionError("capability scope does not admit this publication");
    if (this.evaluate) {
      const admitted = await this.evaluate({ capability, candidates: normalized, request });
      if (admitted !== true) throw new RelayAdmissionError("Relay-local publication policy rejected this publication");
    }
    return { capabilityId: capability.id, candidates: normalized };
  }
}

module.exports = { LocalPublicationPolicy, PUBLISH_SCOPE };
