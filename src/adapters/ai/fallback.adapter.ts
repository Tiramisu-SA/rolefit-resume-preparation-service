import { assertGrounded } from '../../services/grounding';
import type { ResumeSection } from '../../types/domain.types';
import { logger } from '../../utils/logger';
import type { AIModelAdapter, TailorResumeInput } from './ai.types';

/**
 * Tries the primary (LLM) adapter and falls back to the rule-based one when it
 * fails: provider down, timeout, 429 quota, malformed answer, or a result that
 * does not pass the grounding check. The seeker always gets a draft.
 */
export class FallbackTailorAdapter implements AIModelAdapter {
  constructor(
    private readonly primary: AIModelAdapter,
    private readonly fallback: AIModelAdapter,
  ) {}

  async tailorResume(input: TailorResumeInput): Promise<ResumeSection[]> {
    try {
      const sections = await this.primary.tailorResume(input);
      assertGrounded(sections, input.profile);
      return sections;
    } catch (err) {
      // Only the reason is logged, never profile content.
      logger.warn('AI tailoring failed, using the rule-based adapter:', err instanceof Error ? err.message : err);
      return this.fallback.tailorResume(input);
    }
  }
}
