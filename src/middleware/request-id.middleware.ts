import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_HEADER, resolveRequestId } from '../utils/request-id';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The request id, set by `requestId`. Same value as the X-Request-Id header. */
      id: string;
    }
  }
}

/**
 * Keeps the X-Request-Id sent by the API Gateway (or creates one) so log lines
 * and upstream gRPC calls can be matched to the gateway's request. The id is
 * also returned on the response.
 */
export function requestId(req: Request, res: Response, next: NextFunction): void {
  req.id = resolveRequestId(req.get(REQUEST_ID_HEADER));
  res.setHeader('X-Request-Id', req.id);
  next();
}
