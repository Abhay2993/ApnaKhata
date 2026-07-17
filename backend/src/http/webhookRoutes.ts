/**
 * ApnaKhata — External billing webhook
 * ------------------------------------
 * Mounted OUTSIDE /v1 (so it bypasses the service API key): an external POS/ERP
 * billing system authenticates with its own integration key + HMAC signature,
 * verified inside IntegrationService against the exact raw request body.
 */

import { Router } from 'express';

import { IntegrationService } from '../services/IntegrationService';
import { wrap } from './middleware';

export function webhookRoutes(integrations: IntegrationService): Router {
  const r = Router();

  r.post(
    '/sales',
    wrap(async (req, res) => {
      const result = await integrations.ingestSale(
        {
          apiKey: req.header('x-integration-key'),
          signature: req.header('x-signature'),
          timestamp: req.header('x-timestamp'),
          idempotencyKey: req.header('x-idempotency-key'),
        },
        req.rawBody ?? Buffer.from(JSON.stringify(req.body ?? {})),
        req.body,
      );
      res.status(result.status === 'DUPLICATE' ? 200 : 201).json(result);
    }),
  );

  return r;
}
