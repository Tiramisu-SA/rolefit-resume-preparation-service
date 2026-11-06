/**
 * Tries FR-11 (AI resume tailoring) against the real Gemini API, without MongoDB,
 * Supabase or the other services:
 *
 *   npm run try:tailoring [-- --runs 3] [-- --profile profile.json --job job.json]
 *
 * Needs AI_API_KEY and AI_MODEL (environment or .env). Uses the sample profile
 * and job from the tests unless JSON files are given (CandidateProfile and
 * JobPosting shapes, see src/types/domain.types.ts). Each run calls Gemini once,
 * then the same grounding check the service runs before saving, and reports
 * whether the service would keep Gemini's draft or fall back to rule-based.
 * Finally it prints Gemini's draft and every bullet it rephrased.
 */
import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { parseArgs } from 'node:util';
import type { TailorResumeInput } from '../src/adapters/ai/ai.types';
import { GeminiTailorAdapter } from '../src/adapters/ai/gemini.adapter';
import { createGeminiClient } from '../src/adapters/ai/gemini.client';
import { sectionId } from '../src/adapters/ai/resume-content';
import { assertGrounded } from '../src/services/grounding';
import type { CandidateProfile, JobPosting, ResumeSection } from '../src/types/domain.types';
import { makeJob, makeProfile } from '../tests/fakes/fixtures';

/** NFR: AI operations should finish within about 10–20 s. */
const AI_TARGET_MS = 20_000;

const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;
const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, 'utf8')) as T;

/** The candidate's own text for every bullet id, to show what Gemini rephrased. */
function sourceTexts(p: CandidateProfile): Map<string, string> {
  const texts = new Map<string, string>();
  if (p.headline) texts.set(`${sectionId.summary}-b0`, p.headline);
  p.experience.forEach((e, i) => e.bullets.forEach((text, b) => texts.set(`${sectionId.experience(i)}-b${b}`, text)));
  p.projects.forEach((x, i) => x.bullets.forEach((text, b) => texts.set(`${sectionId.project(i)}-b${b}`, text)));
  return texts;
}

function printDraft(sections: ResumeSection[], profile: CandidateProfile): void {
  console.log('\nGemini draft (★ = tailored to the job, [emphasized] = highlighted for this job):');
  for (const s of sections) {
    console.log(`\n  ${s.title}${s.meta ? ` (${s.meta})` : ''}${s.emphasized ? '  [emphasized]' : ''}`);
    for (const b of s.bullets) console.log(`    ${b.tailored ? '★' : '-'} ${b.text}`);
  }

  const sources = sourceTexts(profile);
  const rephrased = sections.flatMap((s) => s.bullets).filter((b) => sources.has(b.id) && sources.get(b.id) !== b.text);
  console.log(`\nRephrased bullets: ${rephrased.length}`);
  for (const b of rephrased) console.log(`  before: ${sources.get(b.id)}\n  after:  ${b.text}\n`);
}

async function main(): Promise<void> {
  const { values: args } = parseArgs({
    options: {
      runs: { type: 'string', default: '3' },
      profile: { type: 'string' },
      job: { type: 'string' },
    },
  });

  const apiKey = process.env.AI_API_KEY?.trim();
  const model = process.env.AI_MODEL?.trim();
  if (!apiKey || !model) {
    console.error('Set AI_API_KEY and AI_MODEL (e.g. in .env, which git ignores). Get a key in Google AI Studio.');
    process.exit(2);
  }
  const runs = Number(args.runs);
  if (!Number.isInteger(runs) || runs < 1) {
    console.error(`--runs must be a whole number above 0 (got "${args.runs}")`);
    process.exit(2);
  }

  const profile: CandidateProfile = args.profile ? readJson(args.profile) : makeProfile();
  const job: JobPosting = args.job ? readJson(args.job) : makeJob();
  const input: TailorResumeInput = { profile, job };
  const gemini = new GeminiTailorAdapter(createGeminiClient({ apiKey, model }));
  console.log(`Model ${model}, job "${job.title}", ${runs} run(s)\n`);

  let kept: ResumeSection[] | undefined;
  const times: number[] = [];
  for (let run = 1; run <= runs; run++) {
    const start = performance.now();
    let sections: ResumeSection[];
    try {
      sections = await gemini.tailorResume(input);
    } catch (err) {
      console.log(`Run ${run}: Gemini FAILED after ${seconds(performance.now() - start)} (${(err as Error).message}): the service would use rule-based.`);
      continue;
    }
    const ms = performance.now() - start;
    times.push(ms);
    try {
      assertGrounded(sections, profile);
      kept = sections;
      console.log(`Run ${run}: Gemini answered in ${seconds(ms)}, grounding check passed: the service keeps this draft.`);
    } catch (err) {
      console.log(`Run ${run}: Gemini answered in ${seconds(ms)} but FAILED the grounding check (${(err as Error).message}): the service would use rule-based.`);
    }
  }

  if (times.length) {
    const slowest = Math.max(...times);
    console.log(
      `\nGemini time: fastest ${seconds(Math.min(...times))}, slowest ${seconds(slowest)} ` +
        `(NFR target ${AI_TARGET_MS / 1000} s: ${slowest <= AI_TARGET_MS ? 'met' : 'NOT met'}).`,
    );
  }
  if (!kept) {
    console.log('\nNo run produced a grounded Gemini draft. Check the key, the model id and the quota (HTTP 429).');
    process.exit(1);
  }
  printDraft(kept, profile);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
