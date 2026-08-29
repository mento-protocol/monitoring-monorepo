#!/usr/bin/env -S -i /usr/local/libexec/mento-node-runtime/bin/node

/**
 * Root-owned privileged launcher for the local-agent GitHub App broker.
 *
 * The fixed /usr/bin/env interpreter clears the caller environment before the
 * pinned Node runtime starts. This avoids a shell or Node startup under
 * caller-controlled PATH, proxy, HOME, config, credential, or startup-hook
 * variables. The installed broker module receives only its reviewed constant
 * environment object.
 */

import {
  BROKER_OPERATION_CWD,
  FIXED_BROKER_ENV,
  brokerFailureMessage,
  runBroker,
} from "file:///usr/local/libexec/mento-local-agent-github-broker.mjs";

try {
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, FIXED_BROKER_ENV);
  process.chdir(BROKER_OPERATION_CWD);
  process.umask(0o077);
  process.exitCode = await runBroker(process.argv.slice(2), {
    env: process.env,
  });
} catch (error) {
  const message = brokerFailureMessage(error);
  process.stderr.write(`local-agent GitHub broker failed: ${message}\n`);
  process.exitCode = 1;
}
