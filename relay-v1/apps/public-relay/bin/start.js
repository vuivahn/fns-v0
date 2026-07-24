"use strict";

const { createLocalReferenceRelayApplication } = require("../src/local-reference-app");

function listenPort(environment) {
  const value = environment.FNS_RELAY_PORT === undefined ? "8080" : environment.FNS_RELAY_PORT;
  if (!/^[0-9]+$/.test(value) || Number(value) < 1 || Number(value) > 65535) {
    process.stderr.write("FNS_RELAY_PORT must be an integer between 1 and 65535\n");
    process.exitCode = 1;
    return null;
  }
  return Number(value);
}

const port = listenPort(process.env);
if (port !== null) {
  const host = process.env.FNS_RELAY_LISTEN_HOST || "127.0.0.1";
  let application;
  try {
    application = createLocalReferenceRelayApplication();
  } catch (error) {
    process.stderr.write(`Relay startup failed: ${error.message}\n`);
    process.exitCode = 1;
  }
  if (application) {
    application.server.once("error", (error) => {
      process.stderr.write(`Relay server failed: ${error.message}\n`);
      application.close();
      process.exitCode = 1;
    });
    application.server.listen(port, host, () => {
      process.stdout.write(`FNS Relay local reference listening on ${host}:${port}\n`);
    });
    const shutdown = () => {
      application.server.close(() => {
        application.close();
        process.exit(0);
      });
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  }
}
