import express, { type Express } from 'express';
import { mountQaMcp, type MountedStatus, type MountOptions } from './mount.js';
import { log } from './log.js';
import { resolveHost, resolveRequireClientToken } from './defaults.js';
import { isLoopbackHost } from './tools/outDir.js';

export type Gateway = {
  app: Express;
  status: MountedStatus;
  /** True when the deployment requires a gateway token on /mcp. */
  gatewayAuth: boolean;
  /** True when each request must carry its own product token (per-user identity). */
  clientTokenRequired: boolean;
};

/**
 * Builds the HTTP gateway app WITHOUT binding a port, so it can be tested and embedded.
 *
 * Routes:
 *   GET  /health   liveness: 200 while the process is up. Safe for a Kubernetes probe.
 *   GET  /ready    readiness: 200 with the connection mode and the live session count.
 *   POST/GET/DELETE /mcp   the MCP endpoint.
 *
 * AUTHENTICATION. Two independent controls, because they answer different questions:
 *
 *   QA_MCP_GATEWAY_TOKEN     "may this caller reach the MCP at all?" A shared secret. Defence in
 *                            depth for a pod that must not be open to anything else in the cluster.
 *                            It is NOT per-user identity.
 *
 *   QA_MCP_REQUIRE_CLIENT_TOKEN
 *                            "who is this caller in the product?" When on, every request must carry
 *                            the caller's own product token (Authorization / x-qa-token), which the
 *                            session primes its connection from. Combined with the per-session
 *                            connection, that is what makes user B unable to act as user A.
 *
 * With REQUIRE_CLIENT_TOKEN on, the gateway secret must arrive in `x-gateway-token` so it does not
 * collide with the product token in Authorization.
 */
export function createGatewayApp(env: NodeJS.ProcessEnv = process.env, mountOptions: MountOptions = {}): Gateway {
  const app = express();
  const gatewayToken = (env['QA_MCP_GATEWAY_TOKEN'] ?? '').trim();
  const clientTokenRequired = resolveRequireClientToken(env);

  if (gatewayToken || clientTokenRequired) {
    app.use('/mcp', (req, res, next) => {
      const authorization = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim();
      const productToken = authorization || String(req.headers['x-qa-token'] ?? '').trim();

      if (gatewayToken) {
        const presented = String(req.headers['x-gateway-token'] ?? '').trim()
          || (clientTokenRequired ? '' : productToken);
        if (presented !== gatewayToken) {
          res.setHeader('WWW-Authenticate', 'Bearer realm="simplify3x-connect"');
          res.status(401).json({ error: 'unauthorized' });
          return;
        }
      }

      if (clientTokenRequired && !productToken) {
        // The session would otherwise inherit whatever identity the process was started with.
        res.setHeader('WWW-Authenticate', 'Bearer realm="simplify3x-connect"');
        res.status(401).json({ error: 'client token required' });
        return;
      }

      next();
    });
  }

  // A gateway other machines can reach never lets a caller pick where files are written.
  const status = mountQaMcp(app, { ...mountOptions, allowOutDir: mountOptions.allowOutDir ?? isLoopbackHost(resolveHost(env)) });

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
  });

  app.get('/ready', (_req, res) => {
    res.json({ status: 'ready', mode: status.mode, sessions: status.sessions() });
  });

  return { app, status, gatewayAuth: !!gatewayToken, clientTokenRequired };
}

/** Startup lines an operator looks for. */
export function announce(host: string, port: number, gateway: Gateway): void {
  log(`simplify3x-connect gateway ready on http://${host}:${port}/mcp`);
  log(`health: http://${host}:${port}/health  ready: http://${host}:${port}/ready`);
  if (gateway.gatewayAuth) log('gateway token required on /mcp');
  if (gateway.clientTokenRequired) {
    log('per-user mode: every request must carry its own product token');
    if ((process.env['QA_MCP_TOKEN'] ?? '').trim()) {
      log('WARNING: QA_MCP_TOKEN is set but ignored in per-user mode; remove it from this deployment');
    }
    if ((process.env['QA_MCP_USER_ID'] ?? '').trim()) {
      log('WARNING: QA_MCP_USER_ID is set but ignored in per-user mode; each user is identified from their own key');
    }
  }
}
