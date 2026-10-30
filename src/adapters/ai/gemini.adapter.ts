import type { ResumeBullet, ResumeSection } from '../../types/domain.types';
import type { AIModelAdapter, TailorResumeInput } from './ai.types';
import type { GenerateJson } from './gemini.client';
import { educationLine, experienceTitle, period, sectionId, SKILL_SEPARATOR } from './resume-content';

/** The model's answer: choices about the profile's own content, referenced by array index. */
interface PlanBullet {
  source: number;
  text: string;
  tailored: boolean;
}
interface PlanItem {
  index: number;
  emphasized: boolean;
  bullets: PlanBullet[];
}
interface TailorPlan {
  summary: string;
  experience: PlanItem[];
  projects: PlanItem[];
  skills: string[];
}

const ITEM_SCHEMA = {
  type: 'OBJECT',
  properties: {
    index: { type: 'INTEGER' },
    emphasized: { type: 'BOOLEAN' },
    bullets: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: { source: { type: 'INTEGER' }, text: { type: 'STRING' }, tailored: { type: 'BOOLEAN' } },
        required: ['source', 'text', 'tailored'],
      },
    },
  },
  required: ['index', 'emphasized', 'bullets'],
};

export const TAILOR_PLAN_SCHEMA = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING' },
    experience: { type: 'ARRAY', items: ITEM_SCHEMA },
    projects: { type: 'ARRAY', items: ITEM_SCHEMA },
    skills: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['summary', 'experience', 'projects', 'skills'],
};

const SYSTEM_INSTRUCTION = `You tailor a candidate's resume to one job.
Use ONLY the candidate content you are given. You may select, reorder and rephrase it so the most relevant points for the job come first.
Never add employers, job titles, dates, tools, skills, numbers, metrics or achievements that are not in the source text.
Rephrasing must keep the meaning of the source bullet; if in doubt, keep the source text.
"index" and "source" refer to the array positions in the input. Mark a bullet "tailored" and an item "emphasized" when it matches the job's skills or responsibilities.
"summary" is one sentence rephrasing the headline. "skills" lists the candidate's skills, most relevant to the job first.`;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

class InvalidPlanError extends Error {
  constructor(where: string) {
    super(`Gemini answer has an invalid ${where}`);
  }
}

function readItems(value: unknown, where: string): PlanItem[] {
  if (!Array.isArray(value)) throw new InvalidPlanError(where);
  return value.map((item) => {
    if (!isObject(item) || !Number.isInteger(item.index) || !Array.isArray(item.bullets)) throw new InvalidPlanError(where);
    const bullets = item.bullets.map((b) => {
      if (!isObject(b) || !Number.isInteger(b.source) || typeof b.text !== 'string') throw new InvalidPlanError(`${where} bullet`);
      return { source: b.source as number, text: b.text, tailored: b.tailored === true };
    });
    return { index: item.index as number, emphasized: item.emphasized === true, bullets };
  });
}

/** Checks the shape of the model's JSON. Content is checked later, against the profile. */
function readPlan(value: unknown): TailorPlan {
  if (!isObject(value)) throw new InvalidPlanError('answer');
  if (typeof value.summary !== 'string') throw new InvalidPlanError('summary');
  if (!Array.isArray(value.skills) || !value.skills.every((s) => typeof s === 'string')) throw new InvalidPlanError('skills');
  return {
    summary: value.summary,
    experience: readItems(value.experience, 'experience'),
    projects: readItems(value.projects, 'projects'),
    skills: value.skills as string[],
  };
}

const numbersIn = (text: string) => text.match(/\d+(?:[.,]\d+)*/g) ?? [];

/**
 * Uses the model's wording only when it is safe: not empty, not much longer than
 * the source, and with no number that the source does not have (a common way an
 * LLM invents achievements). Otherwise the candidate's own text is kept.
 */
export function safeRewrite(source: string, rewrite: string): string {
  const text = rewrite.trim();
  if (!text || text.length > source.length * 2 + 80) return source;
  const allowed = new Set(numbersIn(source));
  return numbersIn(text).every((n) => allowed.has(n)) ? text : source;
}

/** The planned bullets of one profile item; all source bullets in order when the plan has none usable. */
function planBullets(owner: string, sources: string[], item: PlanItem | undefined): ResumeBullet[] {
  const used = new Set<number>();
  const picked: ResumeBullet[] = [];
  for (const b of item?.bullets ?? []) {
    if (b.source < 0 || b.source >= sources.length || used.has(b.source)) continue;
    used.add(b.source);
    picked.push({ id: `${owner}-b${b.source}`, text: safeRewrite(sources[b.source], b.text), tailored: b.tailored });
  }
  return picked.length ? picked : sources.map((text, i) => ({ id: `${owner}-b${i}`, text, tailored: false }));
}

const byIndex = (items: PlanItem[]) => new Map(items.map((item) => [item.index, item]));

/**
 * AI Model Adapter backed by the Google Gemini API. The model only decides what
 * ADR-004 allows (which bullets, their order and wording, what is relevant);
 * titles, dates, project names, tech and education are always copied from the
 * profile. Name, location and education are not sent to the model. Any failure
 * throws, so the caller can fall back to the rule-based adapter.
 */
export class GeminiTailorAdapter implements AIModelAdapter {
  constructor(private readonly generate: GenerateJson) {}

  async tailorResume({ profile, job }: TailorResumeInput): Promise<ResumeSection[]> {
    const input = {
      job: {
        title: job.title,
        requiredSkills: job.requirements.requiredSkills.map((s) => s.name),
        preferredSkills: job.requirements.preferredSkills.map((s) => s.name),
        responsibilities: job.responsibilities,
      },
      candidate: {
        headline: profile.headline ?? '',
        experience: profile.experience.map((e, index) => ({ index, jobTitle: e.jobTitle, companyName: e.companyName, bullets: e.bullets })),
        projects: profile.projects.map((p, index) => ({ index, name: p.name, tech: p.tech, bullets: p.bullets })),
        skills: profile.skills.map((s) => s.name),
      },
    };
    const plan = readPlan(
      await this.generate({ systemInstruction: SYSTEM_INSTRUCTION, prompt: JSON.stringify(input), schema: TAILOR_PLAN_SCHEMA }),
    );

    const sections: ResumeSection[] = [];

    if (profile.headline) {
      sections.push({
        id: sectionId.summary,
        kind: 'summary',
        title: 'Summary',
        bullets: [{ id: `${sectionId.summary}-b0`, text: safeRewrite(profile.headline, plan.summary), tailored: true }],
        emphasized: true,
        included: true,
      });
    }

    const experiencePlan = byIndex(plan.experience);
    profile.experience.forEach((e, i) => {
      const id = sectionId.experience(i);
      const bullets = planBullets(id, e.bullets, experiencePlan.get(i));
      sections.push({
        id,
        kind: 'experience',
        title: experienceTitle(e),
        meta: period(e),
        bullets,
        emphasized: experiencePlan.get(i)?.emphasized ?? false,
        included: true,
      });
    });

    const projectPlan = byIndex(plan.projects);
    profile.projects.forEach((p, i) => {
      const id = sectionId.project(i);
      sections.push({
        id,
        kind: 'project',
        title: p.name,
        meta: p.tech.join(', '),
        bullets: planBullets(id, p.bullets, projectPlan.get(i)),
        emphasized: projectPlan.get(i)?.emphasized ?? false,
        included: true,
      });
    });

    const skillNames = profile.skills.map((s) => s.name);
    if (skillNames.length) {
      // The model's order, with the profile's spelling; skills it invented are dropped and ones it left out go last.
      const byLower = new Map(skillNames.map((s) => [s.trim().toLowerCase(), s]));
      const ordered = [...new Set(plan.skills.map((s) => byLower.get(s.trim().toLowerCase())).filter((s): s is string => !!s))];
      const rest = skillNames.filter((s) => !ordered.includes(s));
      sections.push({
        id: sectionId.skills,
        kind: 'skills',
        title: 'Skills',
        bullets: [{ id: `${sectionId.skills}-b0`, text: [...ordered, ...rest].join(SKILL_SEPARATOR), tailored: false }],
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
