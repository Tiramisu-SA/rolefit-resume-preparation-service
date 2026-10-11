import type { ResumeBullet, ResumeSection } from '../../types/domain.types';
import type { AIModelAdapter, TailorResumeInput } from './ai.types';
import { educationLine, experienceTitle, period, sectionId, SKILL_SEPARATOR } from './resume-content';

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Matches a skill as a whole word, case-insensitively ("Go" does not match "good"; "C++" works). */
function skillMatcher(skills: string[]): (text: string) => boolean {
  const patterns = skills
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(s)}(?=$|[^\\p{L}\\p{N}])`, 'iu'));
  return (text) => patterns.some((p) => p.test(text));
}

/** Relevant bullets first, original order otherwise (Array.prototype.sort is stable). */
function relevantFirst(bullets: ResumeBullet[]): ResumeBullet[] {
  return [...bullets].sort((a, b) => Number(b.tailored) - Number(a.tailored));
}

/**
 * Placeholder AI Model Adapter: deterministic rules, no external AI call.
 * It only selects and reorders the candidate's own content (ADR-004):
 * - bullets that mention a required or preferred skill are marked `tailored` and moved first;
 * - sections with such bullets are `emphasized`;
 * - skills that the job asks for are listed first.
 * It never writes new text. An LLM-backed adapter can replace it behind the same interface.
 */
export class RuleBasedTailorAdapter implements AIModelAdapter {
  async tailorResume({ profile, job }: TailorResumeInput): Promise<ResumeSection[]> {
    const jobSkills = [...job.requirements.requiredSkills, ...job.requirements.preferredSkills].map((s) => s.name);
    const relevant = skillMatcher(jobSkills);
    const wanted = new Set(jobSkills.map((s) => s.trim().toLowerCase()));

    const bullets = (owner: string, texts: string[]): ResumeBullet[] =>
      relevantFirst(texts.map((text, i) => ({ id: `${owner}-b${i}`, text, tailored: relevant(text) })));

    const sections: ResumeSection[] = [];

    // The gRPC profile has no free-text summary yet, so the verified headline stands in for it.
    if (profile.headline) {
      sections.push({
        id: sectionId.summary,
        kind: 'summary',
        title: 'Summary',
        bullets: [{ id: `${sectionId.summary}-b0`, text: profile.headline, tailored: relevant(profile.headline) }],
        emphasized: true,
        included: true,
      });
    }

    profile.experience.forEach((e, i) => {
      const id = sectionId.experience(i);
      const items = bullets(id, e.bullets);
      sections.push({
        id,
        kind: 'experience',
        title: experienceTitle(e),
        meta: period(e),
        bullets: items,
        emphasized: items.some((b) => b.tailored) || relevant(e.jobTitle),
        included: true,
      });
    });

    profile.projects.forEach((p, i) => {
      const id = sectionId.project(i);
      const items = bullets(id, p.bullets);
      sections.push({
        id,
        kind: 'project',
        title: p.name,
        meta: p.tech.join(', '),
        bullets: items,
        emphasized: items.some((b) => b.tailored) || p.tech.some((t) => wanted.has(t.trim().toLowerCase())),
        included: true,
      });
    });

    const skillNames = profile.skills.map((s) => s.name);
    if (skillNames.length) {
      const ordered = [...skillNames].sort((a, b) => Number(wanted.has(b.toLowerCase())) - Number(wanted.has(a.toLowerCase())));
      sections.push({
        id: sectionId.skills,
        kind: 'skills',
        title: 'Skills',
        bullets: [{ id: `${sectionId.skills}-b0`, text: ordered.join(SKILL_SEPARATOR), tailored: false }],
        emphasized: false,
        included: true,
      });
    }

    if (profile.education.length) {
      sections.push({
        id: sectionId.education,
        kind: 'education',
        title: 'Education',
        bullets: profile.education.map((ed, i) => ({ id: `${sectionId.education}-b${i}`, text: educationLine(ed), tailored: false })),
        emphasized: false,
        included: true,
      });
    }

    return sections;
  }
}
