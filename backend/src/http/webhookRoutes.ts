/**
 * ApnaKhata — External webhooks (billing + WhatsApp)
 * --------------------------------------------------
 * Mounted OUTSIDE /v1 (so they bypass the service API key). The billing webhook
 * authenticates with its own integration key + HMAC; the WhatsApp webhook uses
 * Meta's hub verification handshake (GET) and a verify token.
 */

import { Router } from 'express';

import { IntegrationService } from '../services/IntegrationService';
import { WhatsAppBotService, InboundMessage } from '../services/WhatsAppBotService';
import { wrap } from './middleware';

export function webhookRoutes(integrations: IntegrationService, bot?: WhatsAppBotService): Router {
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

  if (bot) {
    const verifyToken = process.env.APNAKHATA_WHATSAPP_VERIFY_TOKEN ?? 'apnakhata-verify';

    // Meta subscription handshake: echo hub.challenge when the token matches.
    r.get('/whatsapp', (req, res) => {
      if (req.query['hub.mode'] === 'subscribe' && req.query['hub.verify_token'] === verifyToken) {
        res.status(200).send(String(req.query['hub.challenge'] ?? ''));
        return;
      }
      res.sendStatus(403);
    });

    // Inbound messages. Accepts Meta's Cloud API shape or a simplified
    // { toPhone, fromPhone, text } payload (used by tests and the demo console).
    r.post(
      '/whatsapp',
      wrap(async (req, res) => {
        const messages = extractInbound(req.body);
        const replies = [];
        for (const m of messages) {
          replies.push(await bot.handleInbound(m));
        }
        // WhatsApp expects a fast 200; the replies are returned for debugging.
        res.status(200).json({ received: messages.length, replies });
      }),
    );
  }

  return r;
}

/** Normalise either payload shape into a flat list of inbound messages. */
function extractInbound(body: unknown): InboundMessage[] {
  if (!body || typeof body !== 'object') return [];
  const b = body as Record<string, any>;

  // Simplified shape used by tests / the demo console.
  if (typeof b.fromPhone === 'string' && typeof b.text === 'string') {
    return [{ toPhone: String(b.toPhone ?? ''), fromPhone: b.fromPhone, text: b.text }];
  }

  // Meta WhatsApp Cloud API shape.
  const out: InboundMessage[] = [];
  for (const entry of b.entry ?? []) {
    for (const change of entry.changes ?? []) {
      const value = change.value ?? {};
      const toPhone: string = value.metadata?.display_phone_number ?? '';
      for (const message of value.messages ?? []) {
        const text: string = message.text?.body ?? message.button?.text ?? '';
        if (message.from && text) out.push({ toPhone, fromPhone: message.from, text });
      }
    }
  }
  return out;
}
