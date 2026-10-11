import { RESUME_FORMATS, ResumeFormat } from '../types/domain.types';
import type { SectionEdit } from '../services/resume.service';
import { FieldError, ValidationError } from '../utils/errors';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** Job ids from the Job Posting Service: `job_<ULID>`, or `job_seed_<slug>` for seed data. */
const JOB_ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,100}$/;
const MAX_SECTIONS = 100;
const MAX_BULLETS = 50;
const MAX_BULLET_TEXT = 2000;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_RE.test(value);
}

export function parseJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID_RE.test(value)) {
    throw new ValidationError([{ field: 'jobId', message: 'Must be a valid job id' }]);
  }
  return value;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Body of PUT /api/drafts/:jobId/format: `{ "format": "company" | "personal" }`. */
export function parseFormat(body: unknown): ResumeFormat {
  const format = isObject(body) ? body.format : undefined;
  if (typeof format !== 'string' || !RESUME_FORMATS.includes(format as ResumeFormat)) {
    throw new ValidationError([{ field: 'format', message: `Must be one of ${RESUME_FORMATS.join(', ')}` }]);
  }
  return format as ResumeFormat;
}

/**
 * Body of PUT /api/drafts/:jobId/sections: `{ "sections": ResumeSection[] }` — the whole
 * draft as the web app holds it. Only `id`, `included` and each bullet's `id` and `text`
 * are read; everything else (titles, dates, kinds) stays as generated.
 */
export function parseSectionEdits(body: unknown): SectionEdit[] {
  const errors: FieldError[] = [];
  const sections = isObject(body) ? body.sections : undefined;
  if (!Array.isArray(sections) || sections.length > MAX_SECTIONS) {
    throw new ValidationError([{ field: 'sections', message: `Must be a list of at most ${MAX_SECTIONS} sections` }]);
  }

  const edits = sections.map((raw, i): SectionEdit => {
    const at = `sections[${i}]`;
    if (!isObject(raw)) {
      errors.push({ field: at, message: 'Must be an object' });
      return { id: '', included: false, bullets: [] };
    }
    if (typeof raw.id !== 'string' || !ID_RE.test(raw.id)) errors.push({ field: `${at}.id`, message: 'Must be a section id' });
    if (typeof raw.included !== 'boolean') errors.push({ field: `${at}.included`, message: 'Must be true or false' });
    const bullets = Array.isArray(raw.bullets) && raw.bullets.length <= MAX_BULLETS ? raw.bullets : undefined;
    if (!bullets) errors.push({ field: `${at}.bullets`, message: `Must be a list of at most ${MAX_BULLETS} bullets` });

    return {
      id: String(raw.id ?? ''),
      included: raw.included === true,
      bullets: (bullets ?? []).map((b: unknown, j: number) => {
        const bt = `${at}.bullets[${j}]`;
        if (!isObject(b) || typeof b.id !== 'string' || !ID_RE.test(b.id)) {
          errors.push({ field: `${bt}.id`, message: 'Must be a bullet id' });
          return { id: '', text: '' };
        }
        const text = typeof b.text === 'string' ? b.text.trim() : '';
        if (!text) errors.push({ field: `${bt}.text`, message: 'Cannot be empty' });
        else if (text.length > MAX_BULLET_TEXT) errors.push({ field: `${bt}.text`, message: `Must be at most ${MAX_BULLET_TEXT} characters` });
        return { id: b.id, text };
      }),
    };
  });

  if (errors.length) throw new ValidationError(errors);
  return edits;
}
