import type { NextFunction, Request, Response } from 'express';
import { logger } from '../utils/logger';

/** Logs one JSON line per request when the response is finished: request id, method, path, status, duration. */
export function requestLogger(req: Request, res: Response, next: NextFunction): void {
  const start = process.hrtime.bigint();
  res.on('finish', () => {
    logger.info('request completed', {
      requestId: req.id,
      method: req.method,
      // No query string: it can hold what a user typed.
      path: req.originalUrl.split('?')[0],
      status: res.statusCode,
      durationMs: Math.round(Number(process.hrtime.bigint() - start) / 1e5) / 10,
    });
  });
  next();
}
