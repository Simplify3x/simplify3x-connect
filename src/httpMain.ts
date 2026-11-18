#!/usr/bin/env node
/**
 * Standalone HTTP entrypoint for the Common QA MCP gateway.
 *
 * The app itself lives in gateway.ts (so it can be tested without binding a port); this file only
 * reads the bind settings and starts listening.
 *
 *   HOST   bind address. Default 127.0.0.1 (a local gateway). Use 0.0.0.0 in a container, because a
 *          socket bound to 127.0.0.1 inside a container is not reachable through a published port.
 *   PORT   default 4060.
 *
 * `mountQaMcp` is registered BEFORE any body parser (it reads the raw body itself), so no
 * express.json() is added here.
 */
import { createGatewayApp, announce } from './gateway.js';
import { resolveHost, resolvePort } from './defaults.js';

const PORT = resolvePort();
const HOST = resolveHost();

const gateway = createGatewayApp();

gateway.app.listen(PORT, HOST, () => announce(HOST, PORT, gateway));
