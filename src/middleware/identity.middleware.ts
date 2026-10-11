import type { NextFunction, Request, Response } from 'express';
import type { ClaimsVerifier } from '../auth/supabase';
import { ForbiddenError, UnauthenticatedError } from '../utils/errors';
import { isUuid } from '../validation/resume.validation';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** The seeker's user id, which is also their candidate profile id. */
      userId?: string;
      /** The verified access token (JWT mode), forwarded to upstream gRPC calls. */
      accessToken?: string;
    }
  }
}

/**
 * JWT mode (default, ADR-008): verifies the Supabase access token itself — the API
 * Gateway keeps the Authorization header — and takes the user id from `sub`.
 * Drafts belong to job seekers, so other roles get 403.
 */
export function identify(verifyClaims: ClaimsVerifier) {
  return async (req: Request, _res: Response, next: NextFunction): Promise<void> => {
    const match = /^Bearer\s+([^\s]+)$/i.exec(req.get('authorization') ?? '');
    if (!match) {
      next(new UnauthenticatedError());
      return;
    }

    try {
      const claims = await verifyClaims(match[1]);
      if (!claims || typeof claims.sub !== 'string' || !isUuid(claims.sub)) {
        next(new UnauthenticatedError());
        return;
      }
      if (claims.app_metadata?.role !== 'seeker') {
        next(new ForbiddenError('Resume drafts are for job seeker accounts only'));
        return;
      }
      req.userId = claims.sub;
      req.accessToken = match[1];
      next();
    } catch {
      next(new UnauthenticatedError());
    }
  };
}

/**
 * AUTH_MODE=mock only (local testing without Supabase): trusts the `X-User-Id`
 * header (a UUID), like the other services' mock mode. Never enable this in production.
 */
export function identifyFromHeader(req: Request, _res: Response, next: NextFunction): void {
  const userId = req.get('x-user-id');
  if (!isUuid(userId)) {
    next(new UnauthenticatedError('Missing or invalid X-User-Id header'));
    return;
  }
  req.userId = userId;
  next();
}
