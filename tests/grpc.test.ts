import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import * as grpc from '@grpc/grpc-js';
import { loadProto, Msg } from '../src/grpc/grpc.utils';
import { startGrpcServer } from '../src/grpc/resume-preparation.grpc';
import { JOB_ID, makeService, seeker, SEEKER_ID, TEMPLATE_JOB_ID } from './fakes/fixtures';

process.env.NODE_ENV = 'test';

type Loaded = { rolefit: { resumepreparation: { v1: { ResumePreparationService: grpc.ServiceClientConstructor } } } };

describe('gRPC GetApprovedResume (contract used by the Application Service)', () => {
  let server: grpc.Server;
  let call: (req: Msg) => Promise<Msg>;

  before(async () => {
    const { service } = makeService();
    const draft = await service.generateTailoredResume(seeker, JOB_ID);
    await service.editResumeDraft(
      seeker,
      JOB_ID,
      draft.sections.map((s) => ({ id: s.id, included: s.kind !== 'project', bullets: s.bullets.map((b) => ({ id: b.id, text: b.text })) })),
    );
    await service.approveResume(seeker, JOB_ID);
    await service.generateTailoredResume(seeker, TEMPLATE_JOB_ID); // generated, not approved

    const started = await startGrpcServer(service, '127.0.0.1', 0);
    server = started.server;
    const loaded = loadProto('resume-preparation.proto') as unknown as Loaded;
    const client = new loaded.rolefit.resumepreparation.v1.ResumePreparationService(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
    const rpc = (client as unknown as Record<string, Function>).GetApprovedResume.bind(client); // eslint-disable-line @typescript-eslint/no-unsafe-function-type
    call = (req) => new Promise((resolve, reject) => rpc(req, (err: grpc.ServiceError | null, res: Msg) => (err ? reject(err) : resolve(res))));
  });
  after(() => server.forceShutdown());

  it('returns the approved resume with only the included sections', async () => {
    const { resume } = await call({ candidate_id: SEEKER_ID, job_id: JOB_ID });
    assert.equal(resume.candidate_id, SEEKER_ID);
    assert.equal(resume.format, 'RESUME_FORMAT_PERSONAL');
    assert.ok(resume.approved_at);
    assert.ok(resume.sections.length > 0);
    assert.ok(resume.sections.every((s: Msg) => s.kind !== 'project'));
  });

  it('maps errors to gRPC status codes', async () => {
    await assert.rejects(call({ candidate_id: SEEKER_ID, job_id: TEMPLATE_JOB_ID }), (e: grpc.ServiceError) => e.code === grpc.status.FAILED_PRECONDITION);
    await assert.rejects(call({ candidate_id: SEEKER_ID, job_id: 'job_unknown' }), (e: grpc.ServiceError) => e.code === grpc.status.NOT_FOUND);
    await assert.rejects(call({ candidate_id: 'nope', job_id: JOB_ID }), (e: grpc.ServiceError) => e.code === grpc.status.INVALID_ARGUMENT);
  });
});

describe('gRPC ListDraftsForJobs (deadline reminders, FR-17)', () => {
  const JOB_A = 'job_A';
  const JOB_B = 'job_B';
  const OTHER_ID = '22222222-2222-4222-8222-222222222222';
  let server: grpc.Server;
  let call: (req: Msg) => Promise<Msg>;

  before(async () => {
    const { service, drafts } = makeService();
    const base = { format: 'personal' as const, sections: [], approved: false, generatedAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' };
    await drafts.save({ ...base, id: 'd1', candidateId: SEEKER_ID, jobId: JOB_A });
    await drafts.save({ ...base, id: 'd2', candidateId: OTHER_ID, jobId: JOB_A, approved: true });
    await drafts.save({ ...base, id: 'd3', candidateId: SEEKER_ID, jobId: JOB_B });

    const started = await startGrpcServer(service, '127.0.0.1', 0);
    server = started.server;
    const loaded = loadProto('resume-preparation.proto') as unknown as Loaded;
    const client = new loaded.rolefit.resumepreparation.v1.ResumePreparationService(`127.0.0.1:${started.port}`, grpc.credentials.createInsecure());
    const rpc = (client as unknown as Record<string, Function>).ListDraftsForJobs.bind(client); // eslint-disable-line @typescript-eslint/no-unsafe-function-type
    call = (req) => new Promise((resolve, reject) => rpc(req, (err: grpc.ServiceError | null, res: Msg) => (err ? reject(err) : resolve(res))));
  });
  after(() => server.forceShutdown());

  it('returns an empty list for no job ids', async () => {
    assert.deepEqual((await call({ job_ids: [] })).drafts, []);
  });

  it('returns every draft (approved or not) for the requested jobs only', async () => {
    const { drafts } = await call({ job_ids: [JOB_A] });
    assert.equal(drafts.length, 2);
    assert.deepEqual(
      drafts.map((d: Msg) => `${d.candidate_id}:${d.job_id}`).sort(),
      [`${SEEKER_ID}:${JOB_A}`, `${OTHER_ID}:${JOB_A}`].sort(),
    );
  });

  it('rejects more than 100 job ids with INVALID_ARGUMENT', async () => {
    const job_ids = Array.from({ length: 101 }, (_, i) => `job_${i}`);
    await assert.rejects(call({ job_ids }), (e: grpc.ServiceError) => e.code === grpc.status.INVALID_ARGUMENT);
    assert.equal((await call({ job_ids: job_ids.slice(0, 100) })).drafts.length, 0);
  });

  it('rejects a malformed job id with INVALID_ARGUMENT', async () => {
    await assert.rejects(call({ job_ids: [JOB_A, 'bad id!'] }), (e: grpc.ServiceError) => e.code === grpc.status.INVALID_ARGUMENT);
  });
});
