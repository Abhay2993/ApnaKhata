/**
 * ApnaKhata — HTTP middleware
 * ---------------------------
 * Auth here is a deliberate placeholder: the gateway trusts an upstream
 * identity provider and reads the caller from `x-user-id` after checking a
 * static service API key. Swap `requireUser` for JWT verification (issuer +
 * audience + signature) before any public exposure — every route already
 * consumes the caller via `req.userId`, so only this file changes.
 */

import { NextFunction, Request, Response } from 'express';

declare module 'express-serve-static-core' {
  interface Request {
    userId?: string;
  }
}

const API_KEY = process.env.APNAKHATA_API_KEY ?? 'dev-key';
const CORS_ORIGIN = process.env.APNAKHATA_CORS_ORIGIN ?? '*';

/**
 * Permit browser clients (the web UI) to call the API cross-origin. Set
 * APNAKHATA_CORS_ORIGIN to the deployed web origin in production; defaults to
 * '*' for local/demo use.
 */
export function cors(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Access-Control-Allow-Origin', CORS_ORIGIN);
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, x-api-key, x-user-id');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') {
    res.status(204).end();
    return;
  }
  next();
}

/** Reject calls without the service API key (all routes). */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (req.header('x-api-key') !== API_KEY) {
    res.status(401).json({ message: 'invalid or missing x-api-key' });
    return;
  }
  next();
}

/** Populate req.userId; reject user-scoped routes without an identity. */
export function requireUser(req: Request, res: Response, next: NextFunction): void {
  const userId = req.header('x-user-id');
  if (!userId) {
    res.status(401).json({ message: 'missing x-user-id (stub auth; JWT in production)' });
    return;
  }
  req.userId = userId;
  next();
}

/** Wrap async handlers so rejections reach the error middleware. */
export const wrap =
  (fn: (req: Request, res: Response) => Promise<void>) =>
  (req: Request, res: Response, next: NextFunction): void => {
    fn(req, res).catch(next);
  };

/** Central error mapping: domain errors → 4xx, everything else → 500. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  const message = err instanceof Error ? err.message : 'internal error';
  const lowered = message.toLowerCase();

  if (lowered.includes('not found')) {
    res.status(404).json({ message });
  } else if (
    lowered.includes('must be') ||
    lowered.includes('cannot') ||
    lowered.includes('insufficient') ||
    lowered.includes('invalid') ||
    lowered.includes('no positive') ||
    lowered.includes('no preferred') ||
    lowered.includes('already')
  ) {
    res.status(400).json({ message });
  } else {
    console.error('unhandled error:', err);
    res.status(500).json({ message: 'internal error' });
  }
}
