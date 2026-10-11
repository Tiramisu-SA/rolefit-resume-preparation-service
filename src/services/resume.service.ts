import { ulid } from 'ulid';
import type { AIModelAdapter } from '../adapters/ai/ai.types';
import type { CandidateProfileReader } from '../grpc/candidate-profile.client';
import type { JobPostingReader } from '../grpc/job-posting.client';
import type { ResumeDraftRepository } from '../repositories/resume-draft.repository';
import type { ResumeDraft, ResumeFormat } from '../types/domain.types';
import { ConflictError, draftNotFound, FieldError, ValidationError } from '../utils/errors';
import { assertGrounded } from './grounding';

/** Who is calling: the seeker's user id (= their candidate profile id) and, in JWT mode, their token. */
export interface Caller {
  userId: string;
  /** Forwarded to upstream gRPC calls so services that verify JWTs see the caller. */
  accessToken?: string;
}

/** What a seeker may change in a draft: which sections are included and the wording of each bullet. */
export interface SectionEdit {
  id: string;
  included: boolean;
  bullets: { id: string; text: string }[];
}

export interface ResumeServiceDeps {
  drafts: ResumeDraftRepository;
  profiles: CandidateProfileReader;
  jobs: JobPostingReader;
  ai: AIModelAdapter;
  now?: () => Date;
  newDraftId?: () => string;
}

/**
 * All business rules of the Resume Preparation Service, shared by REST and gRPC.
 * Content comes only from the candidate's verified profile (ADR-004): the AI
 * adapter selects and orders it, `assertGrounded` checks the result, and the
 * seeker previews, edits and approves before the draft can be used to apply.
 */
export class ResumeService {
  private readonly drafts: ResumeDraftRepository;
  private readonly profiles: CandidateProfileReader;
  private readonly jobs: JobPostingReader;
  private readonly ai: AIModelAdapter;
  private readonly now: () => Date;
  private readonly newDraftId: () => string;

  constructor(deps: ResumeServiceDeps) {
    this.drafts = deps.drafts;
    this.profiles = deps.profiles;
    this.jobs = deps.jobs;
    this.ai = deps.ai;
    this.now = deps.now ?? (() => new Date());
    this.newDraftId = deps.newDraftId ?? (() => `draft_${ulid()}`);
  }

  /** Builds (or rebuilds) the seeker's draft for a job. Regenerating replaces edits and clears approval. */
  async generateTailoredResume(caller: Caller, jobId: string): Promise<ResumeDraft> {
    const [job, profile] = await Promise.all([
      this.jobs.getJob(jobId, caller.accessToken),
      this.profiles.getProfile(caller.userId, caller.accessToken),
    ]);
    if (!profile) throw new ConflictError('PROFILE_REQUIRED', 'Create your profile before tailoring a resume.');
    if (job.status !== 'OPEN') throw new ConflictError('JOB_NOT_OPEN', 'This job is not accepting applications.');

    const sections = await this.ai.tailorResume({ profile, job });
    assertGrounded(sections, profile);

    const existing = await this.drafts.findByCandidateAndJob(caller.userId, jobId);
    const at = this.now().toISOString();
    return this.drafts.save({
      id: existing?.id ?? this.newDraftId(),
      jobId,
      candidateId: caller.userId,
      // UC4: the company template is offered first when the recruiter provided one.
      format: job.applicationSettings.resumeTemplateId ? 'company' : 'personal',
      sections,
      approved: false,
      generatedAt: at,
      updatedAt: at,
    });
  }

  async getResumeDraft(caller: Caller, jobId: string): Promise<ResumeDraft> {
    const draft = await this.drafts.findByCandidateAndJob(caller.userId, jobId);
    if (!draft) throw draftNotFound();
    return draft;
  }

  /**
   * Applies the seeker's edits. Only `included` and bullet text can change; sections
   * and bullets cannot be added, removed or re-typed. Any edit clears approval.
   */
  async editResumeDraft(caller: Caller, jobId: string, edits: SectionEdit[]): Promise<ResumeDraft> {
    const draft = await this.getResumeDraft(caller, jobId);
    const byId = new Map(edits.map((e) => [e.id, e]));
    const errors: FieldError[] = [];

    if (byId.size !== edits.length) errors.push({ field: 'sections', message: 'Section ids must be unique' });
    for (const id of byId.keys()) {
      if (!draft.sections.some((s) => s.id === id)) errors.push({ field: 'sections', message: `Unknown section ${id}` });
    }
    for (const section of draft.sections) {
      const edit = byId.get(section.id);
      if (!edit) {
        errors.push({ field: 'sections', message: `Missing section ${section.id}` });
        continue;
      }
      const sent = edit.bullets.map((b) => b.id).sort().join('|');
      const stored = section.bullets.map((b) => b.id).sort().join('|');
      if (sent !== stored) errors.push({ field: `sections.${section.id}.bullets`, message: 'Bullets cannot be added or removed' });
    }
    if (errors.length) throw new ValidationError(errors);

    const sections = draft.sections.map((section) => {
      const edit = byId.get(section.id)!;
      const textById = new Map(edit.bullets.map((b) => [b.id, b.text]));
      return {
        ...section,
        included: edit.included,
        bullets: section.bullets.map((b) => {
          const text = textById.get(b.id)!;
          // An edited bullet is the seeker's own wording, no longer the generated pick.
          return text === b.text ? b : { ...b, text, tailored: false };
        }),
      };
    });

    return this.drafts.save({ ...draft, sections, approved: false, approvedAt: undefined, updatedAt: this.now().toISOString() });
  }

  /** "company" is allowed only when the job has a company resume template (FR-12). Clears approval. */
  async selectResumeFormat(caller: Caller, jobId: string, format: ResumeFormat): Promise<ResumeDraft> {
    const draft = await this.getResumeDraft(caller, jobId);
    if (format === 'company') {
      const job = await this.jobs.getJob(jobId, caller.accessToken);
      if (!job.applicationSettings.resumeTemplateId) {
        throw new ConflictError('NO_COMPANY_TEMPLATE', 'This job has no company resume template. Use your default format.');
      }
    }
    if (format === draft.format) return draft;
    return this.drafts.save({ ...draft, format, approved: false, approvedAt: undefined, updatedAt: this.now().toISOString() });
  }

  /** The seeker confirms the draft is what they want to submit (UC4 step 7). */
  async approveResume(caller: Caller, jobId: string): Promise<ResumeDraft> {
    const draft = await this.getResumeDraft(caller, jobId);
    if (!draft.sections.some((s) => s.included)) {
      throw new ConflictError('RESUME_EMPTY', 'Include at least one section before approving your resume.');
    }
    if (draft.approved) return draft;
    const at = this.now().toISOString();
    return this.drafts.save({ ...draft, approved: true, approvedAt: at, updatedAt: at });
  }

  /** The approved draft for an application. Used by the Application Service over gRPC and by the web app. */
  async getApprovedResume(candidateId: string, jobId: string): Promise<ResumeDraft> {
    const draft = await this.drafts.findByCandidateAndJob(candidateId, jobId);
    if (!draft) throw draftNotFound();
    if (!draft.approved) throw new ConflictError('RESUME_NOT_APPROVED', 'Approve your resume before applying.');
    return draft;
  }
}
