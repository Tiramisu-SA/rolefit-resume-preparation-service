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
