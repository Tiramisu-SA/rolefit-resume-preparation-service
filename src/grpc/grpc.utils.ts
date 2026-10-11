import path from 'node:path';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import { AppError, ServiceUnavailableError, UpstreamError } from '../utils/errors';
import { logger } from '../utils/logger';

/** Message objects as @grpc/proto-loader returns them (keepCase: snake_case keys, enums as strings). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Msg = Record<string, any>;

export type UnaryCall = (
  request: Msg,
  metadata: grpc.Metadata,
  options: grpc.CallOptions,
  callback: (error: grpc.ServiceError | null, response: Msg) => void,
) => void;

export function loadProto(fileName: string): grpc.GrpcObject {
  const definition = protoLoader.loadSync(path.resolve(__dirname, '../../proto', fileName), {
    keepCase: true,
    longs: String,
    enums: String,
    defaults: true,
    oneofs: true,
  });
  return grpc.loadPackageDefinition(definition);
}

/**
 * The caller's access token, forwarded as `authorization` metadata so services
 * that verify JWTs (ADR-008) see who is asking. Undefined in AUTH_MODE=mock.
 */
export function callerMetadata(accessToken?: string): grpc.Metadata {
  const metadata = new grpc.Metadata();
  if (accessToken) metadata.set('authorization', `Bearer ${accessToken}`);
  return metadata;
}

/**
 * Calls one unary RPC with a deadline. Rejects with `mapError(error)` when it
 * returns an AppError, otherwise with a generic upstream error (details logged).
 */
export function callUnary(
  service: string,
  method: UnaryCall,
  request: Msg,
  deadlineMs: number,
  mapError: (error: grpc.ServiceError) => AppError | undefined = () => undefined,
  metadata: grpc.Metadata = new grpc.Metadata(),
): Promise<Msg> {
  return new Promise((resolve, reject) => {
    method(request, metadata, { deadline: Date.now() + deadlineMs }, (error, response) => {
      if (!error) {
        resolve(response);
        return;
      }
      if (error.code === grpc.status.UNAVAILABLE || error.code === grpc.status.DEADLINE_EXCEEDED) {
        reject(new ServiceUnavailableError(service));
        return;
      }
      const mapped = mapError(error);
      if (!mapped) logger.error(`${service} gRPC error`, { code: error.code, details: error.details });
      reject(mapped ?? new UpstreamError(service));
    });
  });
}

/** Proto enum string → bare value: `SKILL_LEVEL_BASIC` → `BASIC`; UNSPECIFIED / "" → undefined. */
export function fromEnum<T extends string>(prefix: string, value: unknown, allowed: readonly T[]): T | undefined {
  if (typeof value !== 'string') return undefined;
  const bare = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  return allowed.includes(bare as T) ? (bare as T) : undefined;
}

/** Proto3 has no null: "" means "not set". */
export const text = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined);

export const strings = (value: unknown): string[] => (Array.isArray(value) ? value.map(String) : []);

/** Copies only the keys whose value is not undefined (keeps JSON output tidy). */
export function defined<T extends object>(obj: T): T {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as T;
}
