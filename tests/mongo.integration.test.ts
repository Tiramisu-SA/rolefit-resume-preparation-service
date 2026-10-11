import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import mongoose from 'mongoose';
import { connectDatabase, disconnectDatabase } from '../src/config/database';
import { ResumeDraftModel } from '../src/models/resume-draft.model';
import { MongoResumeDraftRepository } from '../src/repositories/mongo-resume-draft.repository';
import type { ResumeDraft } from '../src/types/domain.types';
import { JOB_ID, SEEKER_ID } from './fakes/fixtures';

process.env.NODE_ENV = 'test';

// Runs only against a real MongoDB, e.g.
//   MONGODB_TEST_URI=mongodb://localhost:27017/rolefit_resume_preparation_test npm test
// The database is dropped at the end, so never point this at real data.
const uri = process.env.MONGODB_TEST_URI;

describe('MongoResumeDraftRepository', { skip: !uri && 'set MONGODB_TEST_URI to run' }, () => {
  const repo = new MongoResumeDraftRepository();
  const draft: ResumeDraft = {
    id: 'draft_01TEST',
    candidateId: SEEKER_ID,
    jobId: JOB_ID,
    format: 'personal',
    sections: [
      { id: 'experience-0', kind: 'experience', title: 'Intern · Brightline', meta: '2025-06 – Present', bullets: [{ id: 'experience-0-b0', text: 'Built dashboards', tailored: true }], emphasized: true, included: true },
      { id: 'skills', kind: 'skills', title: 'Skills', bullets: [{ id: 'skills-b0', text: 'React, TypeScript', tailored: false }], emphasized: false, included: true },
    ],
    approved: false,
    generatedAt: '2026-10-11T09:00:00.000Z',
    updatedAt: '2026-10-11T09:00:00.000Z',
  };

  before(async () => {
    await connectDatabase(uri!);
    await ResumeDraftModel.syncIndexes();
  });
  after(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectDatabase();
  });

  it('round-trips a draft as plain domain data', async () => {
    const saved = await repo.save(draft);
    assert.equal(saved.id, draft.id);
    assert.deepEqual(saved.sections, draft.sections);
    assert.equal(saved.approvedAt, undefined);
    assert.deepEqual(await repo.findByCandidateAndJob(SEEKER_ID, JOB_ID), saved);
    assert.equal(await repo.findByCandidateAndJob(SEEKER_ID, 'job_other'), null);
  });

  it('replaces the draft for the same candidate and job, keeping its id', async () => {
    const replaced = await repo.save({ ...draft, id: 'draft_NEWID', approved: true, approvedAt: '2026-10-11T10:00:00.000Z', sections: draft.sections.slice(1) });
    assert.equal(replaced.id, draft.id);
    assert.equal(replaced.approved, true);
    assert.equal(replaced.approvedAt, '2026-10-11T10:00:00.000Z');
    assert.equal(replaced.sections.length, 1);
    assert.equal(await ResumeDraftModel.countDocuments(), 1);

    const unapproved = await repo.save({ ...replaced, approved: false, approvedAt: undefined });
    assert.equal(unapproved.approvedAt, undefined);
  });
});
