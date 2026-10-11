import { educationLine, experienceTitle, period, sectionId, SKILL_SEPARATOR } from '../adapters/ai/resume-content';
import type { CandidateProfile, ResumeSection } from '../types/domain.types';
import { AppError } from '../utils/errors';

/** The AI adapter returned content that is not backed by the profile. Never shown to the user as-is. */
export class UngroundedResumeError extends AppError {
  constructor(reason: string) {
    super(`Generated resume is not grounded in the profile: ${reason}`, 502, 'UNGROUNDED_RESUME');
  }
}

const norm = (s: string) => s.trim().toLowerCase();

/**
 * Checks a generated draft against the verified profile (ADR-004) before it is saved.
 * ADR-004 lets the AI select, reorder, summarize and rephrase, so bullet wording is
 * not compared. What is checked are the facts a resume must never invent:
 * - every section points at a real profile item (by its id);
 * - employer, job title, dates, project names and tech are the profile's own;
 * - a section has no more bullets than its source item;
 * - the skills list holds only profile skills, and education lines match the profile.
 * Throws UngroundedResumeError on the first problem.
 */
export function assertGrounded(sections: ResumeSection[], profile: CandidateProfile): void {
  const seen = new Set<string>();
  const skillNames = new Set(profile.skills.map((s) => norm(s.name)));

  for (const section of sections) {
    if (seen.has(section.id)) throw new UngroundedResumeError(`duplicate section ${section.id}`);
    seen.add(section.id);
    const bulletIds = new Set(section.bullets.map((b) => b.id));
    if (bulletIds.size !== section.bullets.length) throw new UngroundedResumeError(`duplicate bullet id in ${section.id}`);

    switch (section.kind) {
      case 'summary': {
        if (section.id !== sectionId.summary || !profile.headline) throw new UngroundedResumeError('summary without a profile headline');
        if (section.bullets.length > 1) throw new UngroundedResumeError('summary has more than one paragraph');
        break;
      }
      case 'experience': {
        const index = profile.experience.findIndex((_, i) => sectionId.experience(i) === section.id);
        const source = profile.experience[index];
        if (!source) throw new UngroundedResumeError(`unknown experience ${section.id}`);
        if (section.title !== experienceTitle(source)) throw new UngroundedResumeError(`${section.id} changes the employer or job title`);
        if ((section.meta ?? '') !== period(source)) throw new UngroundedResumeError(`${section.id} changes the dates`);
        if (section.bullets.length > source.bullets.length) throw new UngroundedResumeError(`${section.id} adds bullets`);
        break;
      }
      case 'project': {
        const index = profile.projects.findIndex((_, i) => sectionId.project(i) === section.id);
        const source = profile.projects[index];
        if (!source) throw new UngroundedResumeError(`unknown project ${section.id}`);
        if (section.title !== source.name) throw new UngroundedResumeError(`${section.id} changes the project name`);
        if ((section.meta ?? '') !== source.tech.join(', ')) throw new UngroundedResumeError(`${section.id} changes the tech list`);
        if (section.bullets.length > source.bullets.length) throw new UngroundedResumeError(`${section.id} adds bullets`);
        break;
      }
      case 'skills': {
        if (section.id !== sectionId.skills || section.bullets.length > 1) throw new UngroundedResumeError('malformed skills section');
        const listed = (section.bullets[0]?.text ?? '').split(SKILL_SEPARATOR).map(norm).filter(Boolean);
        const invented = listed.find((s) => !skillNames.has(s));
        if (invented) throw new UngroundedResumeError(`skill "${invented}" is not in the profile`);
        break;
      }
      case 'education': {
        if (section.id !== sectionId.education) throw new UngroundedResumeError('malformed education section');
        const allowed = new Set(profile.education.map(educationLine));
        const invented = section.bullets.find((b) => !allowed.has(b.text));
        if (invented) throw new UngroundedResumeError(`education "${invented.text}" is not in the profile`);
        break;
      }
      default:
        throw new UngroundedResumeError(`unknown section kind ${(section as ResumeSection).kind}`);
    }
  }
}
