import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { SectionEdit } from '../src/services/resume.service';
import type { ResumeDraft } from '../src/types/domain.types';
import { AppError } from '../src/utils/errors';
import { CLOSED_JOB_ID, JOB_ID, makeService, OTHER_SEEKER_ID, seeker, SEEKER_ID, TEMPLATE_JOB_ID } from './fakes/fixtures';

const code = (expected: string) => (err: unknown) => err instanceof AppError && err.code === expected;

/** The edit body the web app sends: the draft's sections with one change applied. */
const editsOf = (draft: ResumeDraft, change: (e: SectionEdit[]) => void = () => undefined): SectionEdit[] => {
  const edits = draft.sections.map((s) => ({ id: s.id, included: s.included, bullets: s.bullets.map((b) => ({ id: b.id, text: b.text })) }));
  change(edits);
  return edits;
};

describe('generateTailoredResume', () => {
  it('creates an unapproved draft from the profile and job, forwarding the caller token upstream', async () => {
    const { service, profiles } = makeService();
    const draft = await service.generateTailoredResume(seeker, JOB_ID);
    assert.equal(draft.candidateId, SEEKER_ID);
    assert.equal(draft.jobId, JOB_ID);
    assert.equal(draft.approved, false);
    assert.equal(draft.format, 'personal');
    assert.ok(draft.sections.length > 0);
    assert.deepEqual(profiles.tokens, ['token-abc']);
  });

  it('offers the company format first when the job has a company template', async () => {
    const { service } = makeService();
    assert.equal((await service.generateTailoredResume(seeker, TEMPLATE_JOB_ID)).format, 'company');
  });

  it('needs a profile and an open job', async () => {
    const { service } = makeService();
    await assert.rejects(service.generateTailoredResume({ userId: OTHER_SEEKER_ID }, JOB_ID), code('PROFILE_REQUIRED'));
    await assert.rejects(service.generateTailoredResume(seeker, CLOSED_JOB_ID), code('JOB_NOT_OPEN'));
    await assert.rejects(service.generateTailoredResume(seeker, 'job_missing'), code('JOB_NOT_FOUND'));
  });

  it('regenerating keeps the draft id, drops edits and clears approval', async () => {
    const { service } = makeService();
    const first = await service.generateTailoredResume(seeker, JOB_ID);
    await service.approveResume(seeker, JOB_ID);
    const again = await service.generateTailoredResume(seeker, JOB_ID);
    assert.equal(again.id, first.id);
    assert.equal(again.approved, false);
    assert.equal(again.approvedAt, undefined);
  });
});

describe('getResumeDraft', () => {
  it('returns only the caller\'s own draft', async () => {
    const { service } = makeService();
    await service.generateTailoredResume(seeker, JOB_ID);
    assert.equal((await service.getResumeDraft(seeker, JOB_ID)).candidateId, SEEKER_ID);
    await assert.rejects(service.getResumeDraft({ userId: OTHER_SEEKER_ID }, JOB_ID), code('RESUME_DRAFT_NOT_FOUND'));
  });
});

describe('editResumeDraft', () => {
  it('changes included flags and bullet text, and clears approval', async () => {
    const { service } = makeService();
    const draft = await service.generateTailoredResume(seeker, JOB_ID);
    await service.approveResume(seeker, JOB_ID);

    const edited = await service.editResumeDraft(
      seeker,
      JOB_ID,
      editsOf(draft, (e) => {
        e.find((s) => s.id === 'project-0')!.included = false;
        e.find((s) => s.id === 'experience-0')!.bullets[0].text = 'Built React dashboards for the analytics team';
      }),
    );
    assert.equal(edited.approved, false);
    assert.equal(edited.sections.find((s) => s.id === 'project-0')!.included, false);
    const bullet = edited.sections.find((s) => s.id === 'experience-0')!.bullets[0];
    assert.equal(bullet.text, 'Built React dashboards for the analytics team');
    assert.equal(bullet.tailored, false);
  });

  it('ignores titles and dates sent by the client', async () => {
    const { service } = makeService();
    const draft = await service.generateTailoredResume(seeker, JOB_ID);
    const body = editsOf(draft) as (SectionEdit & { title?: string })[];
    body[1].title = 'CTO · Google';
    const edited = await service.editResumeDraft(seeker, JOB_ID, body);
    assert.equal(edited.sections[1].title, draft.sections[1].title);
  });

  it('rejects added, removed or unknown sections and bullets', async () => {
    const { service } = makeService();
    const draft = await service.generateTailoredResume(seeker, JOB_ID);
    await assert.rejects(service.editResumeDraft(seeker, JOB_ID, editsOf(draft, (e) => e.pop())), code('VALIDATION_ERROR'));
    await assert.rejects(
      service.editResumeDraft(seeker, JOB_ID, editsOf(draft, (e) => e[1].bullets.push({ id: 'experience-0-b9', text: 'Invented' }))),
      code('VALIDATION_ERROR'),
    );
    await assert.rejects(
      service.editResumeDraft(seeker, JOB_ID, editsOf(draft, (e) => e.push({ id: 'experience-5', included: true, bullets: [] }))),
      code('VALIDATION_ERROR'),
    );
  });
});

describe('selectResumeFormat', () => {
  it('allows "company" only when the job has a template', async () => {
    const { service } = makeService();
    await service.generateTailoredResume(seeker, JOB_ID);
    await assert.rejects(service.selectResumeFormat(seeker, JOB_ID, 'company'), code('NO_COMPANY_TEMPLATE'));

    await service.generateTailoredResume(seeker, TEMPLATE_JOB_ID);
    await service.approveResume(seeker, TEMPLATE_JOB_ID);
    const personal = await service.selectResumeFormat(seeker, TEMPLATE_JOB_ID, 'personal');
    assert.equal(personal.format, 'personal');
    assert.equal(personal.approved, false);
  });
});

describe('approveResume / getApprovedResume', () => {
  it('returns the draft only after approval', async () => {
    const { service } = makeService();
    await service.generateTailoredResume(seeker, JOB_ID);
    await assert.rejects(service.getApprovedResume(SEEKER_ID, JOB_ID), code('RESUME_NOT_APPROVED'));

    const approved = await service.approveResume(seeker, JOB_ID);
    assert.equal(approved.approved, true);
    assert.ok(approved.approvedAt);
    assert.equal((await service.getApprovedResume(SEEKER_ID, JOB_ID)).id, approved.id);
  });

  it('refuses to approve a resume with every section left out', async () => {
    const { service } = makeService();
    const draft = await service.generateTailoredResume(seeker, JOB_ID);
    await service.editResumeDraft(seeker, JOB_ID, editsOf(draft, (e) => e.forEach((s) => (s.included = false))));
    await assert.rejects(service.approveResume(seeker, JOB_ID), code('RESUME_EMPTY'));
  });

  it('getApprovedResume reports a missing draft', async () => {
    const { service } = makeService();
    await assert.rejects(service.getApprovedResume(SEEKER_ID, JOB_ID), code('RESUME_DRAFT_NOT_FOUND'));
  });
});
