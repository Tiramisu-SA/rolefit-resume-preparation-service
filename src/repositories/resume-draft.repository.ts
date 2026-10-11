import type { ResumeDraft } from '../types/domain.types';

/**
 * Resume Draft Store. The only code that touches this service's database;
 * returns plain domain objects. One draft per (candidate, job).
 */
export interface ResumeDraftRepository {
  findByCandidateAndJob(candidateId: string, jobId: string): Promise<ResumeDraft | null>;
  /**
   * Inserts or replaces the draft for (draft.candidateId, draft.jobId). Returns what was stored.
   * `draft.id` is used only on insert: an existing draft keeps its id.
   */
  save(draft: ResumeDraft): Promise<ResumeDraft>;
}
