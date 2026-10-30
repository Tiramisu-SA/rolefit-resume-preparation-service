import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { AIModelAdapter } from '../src/adapters/ai/ai.types';
import { FallbackTailorAdapter } from '../src/adapters/ai/fallback.adapter';
import { GeminiTailorAdapter, safeRewrite, TAILOR_PLAN_SCHEMA } from '../src/adapters/ai/gemini.adapter';
import { createGeminiClient, GeminiError, type GenerateJson, type JsonRequest } from '../src/adapters/ai/gemini.client';
import { RuleBasedTailorAdapter } from '../src/adapters/ai/rule-based.adapter';
import { assertGrounded } from '../src/services/grounding';
import type { ResumeSection } from '../src/types/domain.types';
import { makeJob, makeProfile } from './fakes/fixtures';

// Never the real API: every test uses a fake fetch or a fake model.

const okResponse = (text: string, extraParts: object[] = []) =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [...extraParts, { text }] } }] }), { status: 200 });

function fakeFetch(response: () => Response | Promise<Response>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return response();
  }) as typeof fetch;
  return { fn, calls };
}

const request: JsonRequest = { systemInstruction: 'sys', prompt: '{"a":1}', schema: { type: 'OBJECT' } };

describe('createGeminiClient', () => {
  it('posts to generateContent with the key in a header and asks for JSON of the schema', async () => {
    const { fn, calls } = fakeFetch(() => okResponse('{"ok":true}'));
    const generate = createGeminiClient({ apiKey: 'test-key', model: 'models/test-model', fetch: fn });
    assert.deepEqual(await generate(request), { ok: true });

    const [call] = calls;
    assert.equal(call.url, 'https://generativelanguage.googleapis.com/v1beta/models/test-model:generateContent');
    assert.ok(!call.url.includes('test-key'), 'the key must not be in the URL');
    assert.equal((call.init.headers as Record<string, string>)['x-goog-api-key'], 'test-key');
    const body = JSON.parse(String(call.init.body));
    assert.equal(body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(body.generationConfig.responseSchema, { type: 'OBJECT' });
    assert.equal(body.systemInstruction.parts[0].text, 'sys');
    assert.equal(body.contents[0].parts[0].text, '{"a":1}');
  });

  it('skips thinking parts', async () => {
    const { fn } = fakeFetch(() => okResponse('{"ok":1}', [{ text: 'let me think', thought: true }]));
    assert.deepEqual(await createGeminiClient({ apiKey: 'k', model: 'm', fetch: fn })(request), { ok: 1 });
  });

  it('throws GeminiError on HTTP 429, empty answers, invalid JSON and network errors', async () => {
    const cases: [() => Response | Promise<Response>, RegExp][] = [
      [() => new Response('{}', { status: 429 }), /HTTP 429/],
      [() => new Response(JSON.stringify({ candidates: [] }), { status: 200 }), /no text/],
      [() => okResponse('not json'), /invalid JSON/],
      [() => Promise.reject(new Error('socket hang up')), /request failed/],
    ];
    for (const [response, message] of cases) {
      const generate = createGeminiClient({ apiKey: 'k', model: 'm', fetch: fakeFetch(response).fn });
      await assert.rejects(generate(request), (err: unknown) => err instanceof GeminiError && message.test(err.message));
    }
    const quota = createGeminiClient({ apiKey: 'k', model: 'm', fetch: fakeFetch(() => new Response('{}', { status: 429 })).fn });
    await assert.rejects(quota(request), (err: unknown) => err instanceof GeminiError && err.status === 429);
  });
});

// The fixture profile: experience-0 has bullets
//   0 "Organised a good onboarding guide for new interns"
//   1 "Built React dashboards used by 40 analysts"
// project-0 (RoleFit) has bullet 0 "Wrote typed API clients in TypeScript"; skills Figma, TypeScript, React, Go.
const plan = {
  summary: 'Frontend developer building accessible React interfaces',
  experience: [
    {
      index: 0,
      emphasized: true,
      bullets: [
        { source: 1, text: 'Built React dashboards for 40 analysts', tailored: true },
        { source: 0, text: 'Wrote an onboarding guide for new interns', tailored: false },
      ],
    },
  ],
  projects: [{ index: 0, emphasized: true, bullets: [{ source: 0, text: 'Wrote typed TypeScript API clients', tailored: true }] }],
  skills: ['react', 'TypeScript', 'Kubernetes'],
};

function fakeModel(answer: unknown) {
  const requests: JsonRequest[] = [];
  const generate: GenerateJson = async (req) => {
    requests.push(req);
    return structuredClone(answer);
  };
  return { generate, requests };
}

const section = (sections: ResumeSection[], id: string) => sections.find((s) => s.id === id)!;

describe('GeminiTailorAdapter', () => {
  it("builds grounded sections from the model's plan", async () => {
    const profile = makeProfile();
    const sections = await new GeminiTailorAdapter(fakeModel(plan).generate).tailorResume({ profile, job: makeJob() });

    assertGrounded(sections, profile);
    assert.equal(section(sections, 'summary').bullets[0].text, plan.summary);
    const exp = section(sections, 'experience-0');
    assert.equal(exp.title, 'Frontend Intern · Brightline Analytics'); // from the profile, not the model
    assert.equal(exp.meta, '2025-06 – Present');
    assert.ok(exp.emphasized);
    assert.deepEqual(exp.bullets, [
      { id: 'experience-0-b1', text: 'Built React dashboards for 40 analysts', tailored: true },
      { id: 'experience-0-b0', text: 'Wrote an onboarding guide for new interns', tailored: false },
    ]);
    assert.equal(section(sections, 'project-0').meta, 'TypeScript, Next.js');
    // model order with profile spelling; invented "Kubernetes" dropped; missing skills kept at the end
    assert.equal(section(sections, 'skills').bullets[0].text, 'React, TypeScript, Figma, Go');
    assert.equal(section(sections, 'education').bullets[0].text, 'Bachelor in Computer Engineering, Chulalongkorn University, 2026');
  });

  it('sends the job and resume content with the schema, but not name, location or education', async () => {
    const { generate, requests } = fakeModel(plan);
    await new GeminiTailorAdapter(generate).tailorResume({ profile: makeProfile(), job: makeJob() });
    const [req] = requests;
    assert.deepEqual(req.schema, TAILOR_PLAN_SCHEMA);
    assert.match(req.prompt, /Built React dashboards used by 40 analysts/);
    assert.match(req.prompt, /Frontend Developer/);
    for (const privateText of ['Pimchanok', 'Bangkok', 'Chulalongkorn']) assert.ok(!req.prompt.includes(privateText), privateText);
  });

  it('keeps the source text when a rewrite invents a number, and ignores bad or repeated bullet indexes', async () => {
    const answer = structuredClone(plan);
    answer.experience[0].bullets = [
      { source: 1, text: 'Built React dashboards used by 400 analysts', tailored: true },
      { source: 1, text: 'duplicate', tailored: true },
      { source: 7, text: 'does not exist', tailored: true },
    ];
    const sections = await new GeminiTailorAdapter(fakeModel(answer).generate).tailorResume({ profile: makeProfile(), job: makeJob() });
    assert.deepEqual(section(sections, 'experience-0').bullets, [
      { id: 'experience-0-b1', text: 'Built React dashboards used by 40 analysts', tailored: true },
    ]);
  });

  it('keeps all source bullets when the plan has none for an item', async () => {
    const answer = { ...plan, experience: [] };
    const sections = await new GeminiTailorAdapter(fakeModel(answer).generate).tailorResume({ profile: makeProfile(), job: makeJob() });
    assert.deepEqual(
      section(sections, 'experience-0').bullets.map((b) => b.id),
      ['experience-0-b0', 'experience-0-b1'],
    );
  });

  it('rejects an answer with the wrong shape', async () => {
    for (const answer of [null, [], { ...plan, summary: 1 }, { ...plan, skills: 'React' }, { ...plan, experience: [{ index: 'x', bullets: [] }] }]) {
      await assert.rejects(new GeminiTailorAdapter(fakeModel(answer).generate).tailorResume({ profile: makeProfile(), job: makeJob() }));
    }
  });
});

describe('safeRewrite', () => {
  it('accepts rephrasing, rejects new numbers, empty text and much longer text', () => {
    assert.equal(safeRewrite('Cut load time by 30%', 'Reduced load time by 30%'), 'Reduced load time by 30%');
    assert.equal(safeRewrite('Cut load time by 30%', 'Cut load time by 60%'), 'Cut load time by 30%');
    assert.equal(safeRewrite('Led a team', '   '), 'Led a team');
    assert.equal(safeRewrite('Led a team', 'x'.repeat(200)), 'Led a team');
  });
});

describe('FallbackTailorAdapter', () => {
  const input = { profile: makeProfile(), job: makeJob() };
  const ruleBased = new RuleBasedTailorAdapter();

  it("returns the primary adapter's result when it is grounded", async () => {
    const gemini = new GeminiTailorAdapter(fakeModel(plan).generate);
    const sections = await new FallbackTailorAdapter(gemini, ruleBased).tailorResume(input);
    assert.equal(section(sections, 'summary').bullets[0].text, plan.summary);
  });

  it('falls back to rule-based when the primary throws (e.g. 429 quota)', async () => {
    const failing: AIModelAdapter = {
      tailorResume: async () => {
        throw new GeminiError('Gemini answered HTTP 429', 429);
      },
    };
    const sections = await new FallbackTailorAdapter(failing, ruleBased).tailorResume(input);
    assert.deepEqual(sections, await ruleBased.tailorResume(input));
  });

  it('falls back to rule-based when the primary result is not grounded', async () => {
    const inventing: AIModelAdapter = {
      tailorResume: async (i) => {
        const sections = await ruleBased.tailorResume(i);
        section(sections, 'experience-0').title = 'CTO · Google';
        return sections;
      },
    };
    const sections = await new FallbackTailorAdapter(inventing, ruleBased).tailorResume(input);
    assert.equal(section(sections, 'experience-0').title, 'Frontend Intern · Brightline Analytics');
  });
});
