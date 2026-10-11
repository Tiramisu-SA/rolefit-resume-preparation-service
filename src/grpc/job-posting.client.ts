import * as grpc from '@grpc/grpc-js';
import { EDUCATION_LEVELS, JOB_STATUSES, JobPosting, ResumeTemplateInfo, SKILL_LEVELS } from '../types/domain.types';
import { jobNotFound, NotFoundError } from '../utils/errors';
import { callerMetadata, callUnary, fromEnum, loadProto, Msg, strings, text, UnaryCall } from './grpc.utils';

const SERVICE = 'job';

/** What ResumeService needs from the Job Posting Service (lets tests pass a fake). */
export interface JobPostingReader {
  /** A job the seeker can see (OPEN or CLOSED). Rejects with JOB_NOT_FOUND. */
  getJob(jobId: string, accessToken?: string): Promise<JobPosting>;
  /** The job's company resume template, or null when it has none. Metadata only, never the file. */
  getResumeTemplate(jobId: string, accessToken?: string): Promise<ResumeTemplateInfo | null>;
}

type Loaded = {
  rolefit: { jobposting: { v1: { JobPostingService: grpc.ServiceClientConstructor } } };
};

/** proto Job (rolefit.jobposting.v1) → the parts of JobPosting this service uses. Same mapping as Job Discovery. */
export function toJobPosting(msg: Msg): JobPosting {
  const r: Msg = msg.requirements ?? {};
  const a: Msg = msg.application_settings ?? {};
  return {
    id: msg.id,
    companyId: msg.company_id,
    title: msg.title,
    requirements: {
      requiredSkills: (r.required_skills ?? []).map((x: Msg) => ({
        name: x.name,
        level: fromEnum('SKILL_LEVEL_', x.level, SKILL_LEVELS) ?? 'BASIC',
        minimumYears: x.minimum_years ?? 0,
      })),
      preferredSkills: (r.preferred_skills ?? []).map((x: Msg) => ({
        name: x.name,
        level: fromEnum('SKILL_LEVEL_', x.level, SKILL_LEVELS) ?? 'BASIC',
      })),
      minimumExperienceYears: r.minimum_experience_years ?? 0,
      educationLevel: fromEnum('EDUCATION_LEVEL_', r.education_level, EDUCATION_LEVELS) ?? 'NONE',
      acceptedFields: strings(r.accepted_fields),
    },
    responsibilities: strings(msg.responsibilities),
    applicationSettings: {
      applicationDeadline: text(a.application_deadline),
      positionsAvailable: a.positions_available || 1,
      resumeTemplateId: text(a.resume_template_id),
      requireCoverLetter: Boolean(a.require_cover_letter),
    },
    status: fromEnum('JOB_STATUS_', msg.status, JOB_STATUSES) ?? 'DRAFT',
  };
}

export class JobPostingClient implements JobPostingReader {
  private readonly getJobRpc: UnaryCall;
  private readonly getResumeTemplateRpc: UnaryCall;

  constructor(
    address: string,
    private readonly deadlineMs: number,
  ) {
    const loaded = loadProto('job-posting.proto') as unknown as Loaded;
    const client = new loaded.rolefit.jobposting.v1.JobPostingService(address, grpc.credentials.createInsecure());
    const rpc = client as unknown as { GetJob: UnaryCall; GetResumeTemplate: UnaryCall };
    this.getJobRpc = rpc.GetJob.bind(client);
    this.getResumeTemplateRpc = rpc.GetResumeTemplate.bind(client);
  }

  async getJob(jobId: string, accessToken?: string): Promise<JobPosting> {
    const response = await callUnary(
      SERVICE,
      this.getJobRpc,
      { job_id: jobId },
      this.deadlineMs,
      (error) => (error.code === grpc.status.NOT_FOUND || error.code === grpc.status.INVALID_ARGUMENT ? jobNotFound() : undefined),
      callerMetadata(accessToken),
    );
    if (!response.job) throw jobNotFound();
    return toJobPosting(response.job);
  }

  async getResumeTemplate(jobId: string, accessToken?: string): Promise<ResumeTemplateInfo | null> {
    try {
      const response = await callUnary(
        SERVICE,
        this.getResumeTemplateRpc,
        { job_id: jobId, include_content: false },
        this.deadlineMs,
        (error) => (error.code === grpc.status.NOT_FOUND ? new NotFoundError('TEMPLATE_NOT_FOUND', 'No template') : undefined),
        callerMetadata(accessToken),
      );
      const t: Msg | undefined = response.template;
      return t ? { id: t.id, fileName: t.file_name, contentType: t.content_type } : null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}
