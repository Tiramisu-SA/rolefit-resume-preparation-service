import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { RuleBasedTailorAdapter } from '../src/adapters/ai/rule-based.adapter';
import { assertGrounded, UngroundedResumeError } from '../src/services/grounding';
import type { ResumeSection } from '../src/types/domain.types';
import { makeJob, makeProfile } from './fakes/fixtures';

const adapter = new RuleBasedTailorAdapter();
const tailor = (profile = makeProfile(), job = makeJob()) => adapter.tailorResume({ profile, job });
const byId = (sections: ResumeSection[], id: string) => sections.find((s) => s.id === id)!;

describe('RuleBasedTailorAdapter', () => {
  it('builds sections only from the profile and passes the grounding check', async () => {
    const profile = makeProfile();
    const sections = await tailor(profile);
    assert.deepEqual(
      sections.map((s) => s.id),
      ['summary', 'experience-0', 'project-0', 'skills', 'education'],
    );
    assert.doesNotThrow(() => assertGrounded(sections, profile));

    const profileText = new Set([profile.headline, ...profile.experience.flatMap((e) => e.bullets), ...profile.projects.flatMap((p) => p.bullets)]);
    for (const s of sections.filter((x) => ['summary', 'experience', 'project'].includes(x.kind))) {
      for (const b of s.bullets) assert.ok(profileText.has(b.text), `"${b.text}" must come from the profile`);
    }
  });

  it('marks bullets that mention a job skill as tailored and moves them first', async () => {
    const exp = byId(await tailor(), 'experience-0');
    assert.equal(exp.bullets[0].text, 'Built React dashboards used by 40 analysts');
    assert.equal(exp.bullets[0].tailored, true);
    assert.equal(exp.emphasized, true);
  });

  it('matches skills as whole words ("Go" does not match "good")', async () => {
    const job = makeJob({ requirements: { ...makeJob().requirements, requiredSkills: [{ name: 'Go', level: 'BASIC', minimumYears: 0 }], preferredSkills: [] } });
    const exp = byId(await tailor(makeProfile(), job), 'experience-0');
    assert.ok(exp.bullets.every((b) => !b.tailored));
  });

  it('lists the skills the job asks for first and never adds skills', async () => {
    const skills = byId(await tailor(), 'skills').bullets[0].text.split(', ');
    assert.deepEqual(skills.slice(0, 2).sort(), ['React', 'TypeScript']);
    assert.deepEqual([...skills].sort(), ['Figma', 'Go', 'React', 'TypeScript']);
  });

  it('leaves out summary and empty sections when the profile has no data for them', async () => {
    const sections = await tailor(makeProfile({ headline: null, skills: [], education: [], projects: [] }));
    assert.deepEqual(sections.map((s) => s.id), ['experience-0']);
  });
});

describe('assertGrounded (ADR-004)', () => {
  it('rejects a skill that is not in the profile', async () => {
    const profile = makeProfile();
    const sections = await tailor(profile);
    byId(sections, 'skills').bullets[0].text += ', Kubernetes';
    assert.throws(() => assertGrounded(sections, profile), UngroundedResumeError);
  });

  it('rejects a changed employer or job title', async () => {
    const profile = makeProfile();
    const sections = await tailor(profile);
    byId(sections, 'experience-0').title = 'Senior Engineer · Google';
    assert.throws(() => assertGrounded(sections, profile), /employer or job title/);
  });

  it('rejects added bullets and unknown sections', async () => {
    const profile = makeProfile();
    const withExtraBullet = await tailor(profile);
    byId(withExtraBullet, 'project-0').bullets.push({ id: 'project-0-b9', text: 'Won a national award', tailored: true });
    assert.throws(() => assertGrounded(withExtraBullet, profile), /adds bullets/);

    const withUnknown = await tailor(profile);
    withUnknown.push({ id: 'experience-7', kind: 'experience', title: 'x', bullets: [], emphasized: false, included: true });
    assert.throws(() => assertGrounded(withUnknown, profile), /unknown experience/);
  });

  it('allows rephrased bullet text (ADR-004 permits rephrasing)', async () => {
    const profile = makeProfile();
    const sections = await tailor(profile);
    byId(sections, 'experience-0').bullets[0].text = 'Delivered React dashboards for 40 analysts';
    assert.doesNotThrow(() => assertGrounded(sections, profile));
  });
});
