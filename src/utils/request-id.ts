import { randomUUID } from 'node:crypto';

/** HTTP header and gRPC metadata key of the request id. The API Gateway sets it on every request. */
export const REQUEST_ID_HEADER = 'x-request-id';

// Letters, digits, ".", "_", "-" only, so a caller cannot inject log lines. Same rule as the API Gateway.
const SAFE_ID = /^[A-Za-z0-9._-]{1,128}$/;

/** Keeps a safe incoming id, or creates a new UUID (e.g. a direct call that did not go through the gateway). */
export function resolveRequestId(incoming: unknown): string {
  return typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
}
