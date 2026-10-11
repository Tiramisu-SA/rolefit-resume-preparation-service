import type { NextFunction, Request, Response } from 'express';
import { AppError, ValidationError } from '../utils/errors';
import { logger } from '../utils/logger';

/** 404 for unknown routes. */
export function notFoundHandler(req: Request, res: Response): void {
  res.status(404).json({ error: { code: 'ROUTE_NOT_FOUND', message: `${req.method} ${req.path} not found` } });
}

/**
 * Converts thrown errors into JSON HTTP responses:
 * `{ error: { code, message, details? } }`. Unknown errors are logged and
 * answered with a generic 500 so internal details never leak.
 */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction): void {
  if ((err as { type?: unknown })?.type === 'entity.parse.failed') {
    res.status(400).json({ error: { code: 'MALFORMED_JSON', message: 'The request body is not valid JSON' } });
    return;
  }
  if (err instanceof AppError) {
    const details = err instanceof ValidationError ? { details: err.details } : {};
    res.status(err.httpStatus).json({ error: { code: err.code, message: err.message, ...details } });
    return;
  }

  logger.error('Unhandled error', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
}
