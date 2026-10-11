import * as grpc from '@grpc/grpc-js';
import type { ResumeService } from '../services/resume.service';
import type { ResumeDraft } from '../types/domain.types';
import { AppError } from '../utils/errors';
import { logger } from '../utils/logger';
import { isUuid, parseJobId } from '../validation/resume.validation';
import { loadProto, Msg } from './grpc.utils';

type Loaded = {
  rolefit: { resumepreparation: { v1: { ResumePreparationService: grpc.ServiceClientConstructor } } };
};

/** Domain draft → proto ApprovedResume. Only included sections, which is what gets submitted. */
export function toProtoApprovedResume(draft: ResumeDraft): Msg {
  return {
    draft_id: draft.id,
    candidate_id: draft.candidateId,
    job_id: draft.jobId,
    format: draft.format === 'company' ? 'RESUME_FORMAT_COMPANY' : 'RESUME_FORMAT_PERSONAL',
    sections: draft.sections
      .filter((s) => s.included)
      .map((s) => ({
        id: s.id,
        kind: s.kind,
        title: s.title,
        meta: s.meta ?? '',
        bullets: s.bullets.map((b) => ({ id: b.id, text: b.text, tailored: b.tailored })),
        emphasized: s.emphasized,
      })),
    approved_at: draft.approvedAt ?? '',
    updated_at: draft.updatedAt,
  };
}

function toGrpcError(err: unknown): Partial<grpc.ServiceError> {
  if (err instanceof AppError) {
    const code =
      err.httpStatus === 400
        ? grpc.status.INVALID_ARGUMENT
        : err.httpStatus === 404
          ? grpc.status.NOT_FOUND
          : err.httpStatus === 409
            ? grpc.status.FAILED_PRECONDITION
            : err.httpStatus === 503
              ? grpc.status.UNAVAILABLE
              : grpc.status.INTERNAL;
    const metadata = new grpc.Metadata();
    metadata.set('x-error-code', err.code);
    return { code, details: err.message, metadata };
  }
  logger.error('Unhandled gRPC error', err);
  return { code: grpc.status.INTERNAL, details: 'Internal server error' };
}

export function createResumePreparationHandlers(resumes: ResumeService): grpc.UntypedServiceImplementation {
  const GetApprovedResume: grpc.handleUnaryCall<Msg, Msg> = async (call, callback) => {
    try {
      const { candidate_id: candidateId, job_id: jobId } = call.request;
      if (!isUuid(candidateId)) throw new AppError('candidate_id must be a UUID', 400, 'VALIDATION_ERROR');
      const draft = await resumes.getApprovedResume(candidateId, parseJobId(jobId));
      callback(null, { resume: toProtoApprovedResume(draft) });
    } catch (err) {
      callback(toGrpcError(err));
    }
  };
  return { GetApprovedResume };
}

/** Starts the internal gRPC server. Resolves with the bound port (useful when port 0 is requested in tests). */
export function startGrpcServer(resumes: ResumeService, host: string, port: number): Promise<{ server: grpc.Server; port: number }> {
  const loaded = loadProto('resume-preparation.proto') as unknown as Loaded;
  const server = new grpc.Server();
  server.addService(loaded.rolefit.resumepreparation.v1.ResumePreparationService.service, createResumePreparationHandlers(resumes));
  return new Promise((resolve, reject) => {
    server.bindAsync(`${host}:${port}`, grpc.ServerCredentials.createInsecure(), (err, boundPort) => {
      if (err) reject(err);
      else resolve({ server, port: boundPort });
    });
  });
}
