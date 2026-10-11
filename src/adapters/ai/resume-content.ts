import type { Education, Experience } from '../../types/domain.types';

// How profile items are written on a resume. Shared by the adapter (to build
// sections) and the grounding check (to know what text a section may contain),
// so both agree on the exact wording.

/** "2024-06 – Present" from YYYY-MM-DD dates. */
export function period(e: Pick<Experience, 'startDate' | 'endDate' | 'isCurrent'>): string {
  const from = e.startDate ? e.startDate.slice(0, 7) : '';
  const to = e.isCurrent || !e.endDate ? 'Present' : e.endDate.slice(0, 7);
  return from ? `${from} – ${to}` : to;
}

export function experienceTitle(e: Experience): string {
  return `${e.jobTitle} · ${e.companyName}`;
}

/** "Bachelor in Computer Engineering, Chulalongkorn University, 2026" */
export function educationLine(ed: Education): string {
  const degree = ed.fieldOfStudy ? `${ed.degree} in ${ed.fieldOfStudy}` : ed.degree;
  return [degree, ed.institutionName, ed.year].filter(Boolean).join(', ');
}

export const SKILL_SEPARATOR = ', ';

/** Section ids are positions in the profile, so a regenerated draft keeps the same ids. */
export const sectionId = {
  summary: 'summary',
  skills: 'skills',
  education: 'education',
  experience: (index: number) => `experience-${index}`,
  project: (index: number) => `project-${index}`,
};
