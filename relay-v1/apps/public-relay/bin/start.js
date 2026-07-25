"use strict";

process.umask(0o077);

const fs = require("fs");
const { clearTimeout, setTimeout } = require("timers");
const { createLocalReferenceRelayApplication } = require("../src/local-reference-app");

const BAKED_SOURCE_OFFER_FILENAME = "/usr/share/doc/fns-relay/SOURCE-OFFER-URL";

function listenPort(environment) {
  const value = environment.FNS_RELAY_PORT === undefined ? "8080" : environment.FNS_RELAY_PORT;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    process.stderr.write("FNS_RELAY_PORT must be an integer between 1 and 65535\n");
    process.exitCode = 1;
    return null;
  }
  return Number(value);
}

function shutdownTimeoutMilliseconds(environment) {
  const value =
    environment.FNS_RELAY_SHUTDOWN_TIMEOUT_MS === undefined ? "8000" : environment.FNS_RELAY_SHUTDOWN_TIMEOUT_MS;
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) < 1000 || Number(value) > 120000) {
    process.stderr.write("FNS_RELAY_SHUTDOWN_TIMEOUT_MS must be an integer between 1000 and 120000\n");
    process.exitCode = 1;
    return null;
  }
  return Number(value);
}

function readBakedSourceOfferUrl() {
  if (!fs.existsSync(BAKED_SOURCE_OFFER_FILENAME)) return null;
  try {
    const value = fs.readFileSync(BAKED_SOURCE_OFFER_FILENAME, "utf8").trim();
    if (value.length === 0) throw new Error("the source offer file is empty");
    return value;
  } catch (error) {
    throw new Error(`could not read baked source offer: ${error.message}`, { cause: error });
  }
}

function installShutdownHandler(application, timeoutMilliseconds) {
  let shuttingDown = false;
  let finished = false;
  let forced = false;
  let finalDeadline = null;
  const finish = (exitCode) => {
    if (finished) return;
    finished = true;
    if (finalDeadline !== null) clearTimeout(finalDeadline);
    try {
      application.close();
    } catch (error) {
      process.stderr.write(`Relay shutdown failed: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    process.exitCode = exitCode;
  };
  return (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    process.stdout.write(`FNS Relay received ${signal}; draining HTTP connections\n`);
    application.server.closeIdleConnections?.();
    const deadline = setTimeout(() => {
      process.stderr.write(`Relay shutdown exceeded ${timeoutMilliseconds}ms; closing remaining HTTP connections\n`);
      forced = true;
      application.server.closeAllConnections?.();
      finalDeadline = setTimeout(() => {
        process.stderr.write("Relay server did not close after remaining HTTP connections were terminated\n");
        finish(1);
      }, 1000);
      finalDeadline.unref();
    }, timeoutMilliseconds);
    deadline.unref();
    application.server.close((error) => {
      clearTimeout(deadline);
      if (error) {
        process.stderr.write(`Relay server shutdown failed: ${error.message}\n`);
        finish(1);
        return;
      }
      finish(forced ? 1 : 0);
    });
  };
}

const port = listenPort(process.env);
const timeoutMilliseconds = shutdownTimeoutMilliseconds(process.env);
if (port !== null && timeoutMilliseconds !== null) {
  const host = process.env.FNS_RELAY_LISTEN_HOST || "127.0.0.1";
  let application;
  try {
    application = createLocalReferenceRelayApplication({ builtSourceOfferUrl: readBakedSourceOfferUrl() });
  } catch (error) {
    process.stderr.write(`Relay startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (application) {
    application.server.requestTimeout = 30000;
    application.server.headersTimeout = 35000;
    application.server.keepAliveTimeout = 5000;
    application.server.once("error", (error) => {
      process.stderr.write(`Relay server failed: ${error.message}\n`);
      application.close();
      process.exitCode = 1;
    });
    application.server.listen(port, host, () => {
      process.stdout.write(`FNS Relay local reference listening on ${host}:${port}\n`);
    });
    const shutdown = installShutdownHandler(application, timeoutMilliseconds);
    process.once("SIGINT", () => shutdown("SIGINT"));
    process.once("SIGTERM", () => shutdown("SIGTERM"));
  }
}

module.exports = { installShutdownHandler, listenPort, readBakedSourceOfferUrl, shutdownTimeoutMilliseconds };
