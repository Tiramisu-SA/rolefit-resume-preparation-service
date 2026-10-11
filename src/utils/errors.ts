/**
 * Base error type for this service. The error middleware turns it into
 * `{ error: { code, message, details? } }`, the same envelope the other
 * RoleFit services use, so the frontend parses all of them the same way.
 * The gRPC server maps `httpStatus` to a gRPC status code.
 */
export class AppError extends Error {
  constructor(
    message: string,
    public readonly httpStatus: number = 500,
    public readonly code: string = 'INTERNAL_ERROR',
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export interface FieldError {
  /** Name of the invalid field, e.g. `sections[2].bullets[0].text`. */
  field: string;
  message: string;
}

export class ValidationError extends AppError {
  constructor(
    public readonly details: FieldError[],
    message = 'Some fields are invalid',
  ) {
    super(message, 400, 'VALIDATION_ERROR');
  }
}

export class UnauthenticatedError extends AppError {
  constructor(message = 'Missing or invalid access token') {
    super(message, 401, 'UNAUTHENTICATED');
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You are not allowed to do this') {
    super(message, 403, 'FORBIDDEN');
  }
}

/** 404 with a resource-specific code such as RESUME_DRAFT_NOT_FOUND. */
export class NotFoundError extends AppError {
  constructor(code: string, message: string) {
    super(message, 404, code);
  }
}

/** 409: the request is valid but the current state does not allow it. */
export class ConflictError extends AppError {
  constructor(code: string, message: string) {
    super(message, 409, code);
  }
}

/** An upstream service (Candidate Profile, Job Posting) is down or timed out. */
export class ServiceUnavailableError extends AppError {
  constructor(service: string) {
    super(`The ${service} service is unavailable. Please try again.`, 503, 'SERVICE_UNAVAILABLE');
  }
}

/** An upstream service answered with an unexpected error. Details are logged, not returned. */
export class UpstreamError extends AppError {
  constructor(service: string) {
    super(`The ${service} service returned an error.`, 502, 'UPSTREAM_ERROR');
  }
}

export const jobNotFound = () => new NotFoundError('JOB_NOT_FOUND', 'Job not found');
export const draftNotFound = () => new NotFoundError('RESUME_DRAFT_NOT_FOUND', 'No resume draft for this job yet');
