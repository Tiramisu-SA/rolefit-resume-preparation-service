import type { CandidateProfile, JobPosting, ResumeSection } from '../../types/domain.types';

export interface TailorResumeInput {
  /** The candidate's verified profile: the only allowed source of resume content (ADR-004). */
  profile: CandidateProfile;
  job: JobPosting;
}

/**
 * AI Model Adapter (an internal module, not a microservice). Isolates the
 * service from the AI/LLM provider. An implementation may select, reorder,
 * summarize or rephrase profile content for the job, but must never add facts
 * that are not in the profile. ResumeService checks the result with
 * `assertGrounded` before saving it.
 */
export interface AIModelAdapter {
  tailorResume(input: TailorResumeInput): Promise<ResumeSection[]>;
}
