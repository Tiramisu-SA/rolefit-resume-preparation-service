import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it, mock } from 'node:test';
import * as grpc from '@grpc/grpc-js';
import { buildApp } from '../src/app';
import { CandidateProfileClient } from '../src/grpc/candidate-profile.client';
import { callerMetadata, loadProto, Msg } from '../src/grpc/grpc.utils';
import { startGrpcServer } from '../src/grpc/resume-preparation.grpc';
import { identifyFromHeader } from '../src/middleware/identity.middleware';
import { JOB_ID, makeService, seeker, SEEKER_ID } from './fakes/fixtures';

process.env.NODE_ENV = 'test';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Runs `fn` with the logger switched on and returns what it printed with console.log. */
async function captureLogs(fn: () => Promise<void>): Promise<string[]> {
  const log = mock.method(console, 'log', () => {});
  process.env.NODE_ENV = 'development';
  try {
    await fn();
    await new Promise((resolve) => setImmediate(resolve)); // let 'finish' handlers run
    return log.mock.calls.map((c) => c.arguments.join(' '));
  } finally {
    process.env.NODE_ENV = 'test';
    log.mock.restore();
  }
}

describe('X-Request-Id (REST)', () => {
  let url = '';
  let server: Server;
  const { service, profiles } = makeService();

  before(async () => {
    const app = buildApp({ resumeService: service, identity: identifyFromHeader, corsOrigin: 'http://localhost:3000', isDatabaseReady: () => true });
    server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const get = (headers: Record<string, string> = {}) => fetch(`${url}/api/drafts/${JOB_ID}`, { headers: { 'X-User-Id': SEEKER_ID, ...headers } });

  it("returns the gateway's id on the response", async () => {
    const res = await get({ 'X-Request-Id': 'gw-req-123' });
    assert.equal(res.headers.get('x-request-id'), 'gw-req-123');
  });

  it('creates a UUID when the id is missing or unsafe', async () => {
    assert.match((await get()).headers.get('x-request-id')!, UUID);
    assert.match((await get({ 'X-Request-Id': 'evil id; injected' })).headers.get('x-request-id')!, UUID);
    assert.match((await get({ 'X-Request-Id': 'x'.repeat(129) })).headers.get('x-request-id')!, UUID);
  });

  it('forwards the id to the Candidate Profile Service when generating a draft', async () => {
    const res = await fetch(`${url}/api/drafts/${JOB_ID}/generate`, { method: 'POST', headers: { 'X-User-Id': SEEKER_ID, 'X-Request-Id': 'gw-gen-1' } });
    assert.equal(res.status, 201);
    assert.equal(profiles.requestIds.at(-1), 'gw-gen-1');
  });

  it('logs one line per request with the id, method, path and status', async () => {
    const lines = await captureLogs(async () => {
      await get({ 'X-Request-Id': 'gw-log-1' });
    });
    assert.ok(
      lines.some((l) => l.includes('[gw-log-1]') && new RegExp(`GET /api/drafts/${JOB_ID} 200 \\d+\\.\\dms$`).test(l)),
      `no request log line in: ${JSON.stringify(lines)}`,
    );
  });

  it('allows and exposes the header for browsers (CORS)', async () => {
    const preflight = await fetch(`${url}/api/drafts/${JOB_ID}`, { method: 'OPTIONS' });
    assert.match(preflight.headers.get('access-control-allow-headers')!, /X-Request-Id/);
    assert.equal((await get()).headers.get('access-control-expose-headers'), 'X-Request-Id');
  });
});

describe('x-request-id (gRPC)', () => {
  it('callerMetadata sets the request id next to the token', () => {
    const metadata = callerMetadata({ accessToken: 'token-abc', requestId: 'gw-1' });
    assert.deepEqual(metadata.get('x-request-id'), ['gw-1']);
    assert.deepEqual(metadata.get('authorization'), ['Bearer token-abc']);
    assert.deepEqual(callerMetadata().get('x-request-id'), []);
  });

  it('CandidateProfileClient sends the id to the real gRPC server', async () => {
    type Loaded = { rolefit: { candidateprofile: { v1: { CandidateProfileService: grpc.ServiceClientConstructor } } } };
    const loaded = loadProto('candidate-profile.proto') as unknown as Loaded;
    const seen: grpc.MetadataValue[] = [];
    const upstream = new grpc.Server();
    upstream.addService(loaded.rolefit.candidateprofile.v1.CandidateProfileService.service, {
      GetProfile: (call: grpc.ServerUnaryCall<Msg, Msg>, callback: grpc.sendUnaryData<Msg>) => {
        seen.push(...call.metadata.get('x-request-id'));
        callback({ code: grpc.status.NOT_FOUND, details: 'no profile' });
      },
    });
    const port = await new Promise<number>((resolve, reject) =>
      upstream.bindAsync('127.0.0.1:0', grpc.ServerCredentials.createInsecure(), (err, p) => (err ? reject(err) : resolve(p))),
    );
    try {
      const client = new CandidateProfileClient(`127.0.0.1:${port}`, 2000);
      assert.equal(await client.getProfile(SEEKER_ID, { requestId: 'gw-grpc-1' }), null);
      assert.deepEqual(seen, ['gw-grpc-1']);
    } finally {
      upstream.forceShutdown();
    }
  });

  it('GetApprovedResume logs the id sent by the Application Service', async () => {
    const { service } = makeService();
    await service.generateTailoredResume(seeker, JOB_ID);
    await service.approveResume(seeker, JOB_ID);
    const { server, port } = await startGrpcServer(service, '127.0.0.1', 0);
    type Loaded = { rolefit: { resumepreparation: { v1: { ResumePreparationService: grpc.ServiceClientConstructor } } } };
    const loaded = loadProto('resume-preparation.proto') as unknown as Loaded;
    const client = new loaded.rolefit.resumepreparation.v1.ResumePreparationService(`127.0.0.1:${port}`, grpc.credentials.createInsecure());
    const rpc = (client as unknown as Record<string, Function>).GetApprovedResume.bind(client); // eslint-disable-line @typescript-eslint/no-unsafe-function-type
    const metadata = new grpc.Metadata();
    metadata.set('x-request-id', 'app-svc-7');
    try {
      const lines = await captureLogs(async () => {
        await new Promise((resolve, reject) =>
          rpc({ candidate_id: SEEKER_ID, job_id: JOB_ID }, metadata, (err: grpc.ServiceError | null, res: Msg) => (err ? reject(err) : resolve(res))),
        );
      });
      assert.ok(
        lines.some((l) => l.includes('[app-svc-7] gRPC GetApprovedResume OK')),
        `no gRPC log line in: ${JSON.stringify(lines)}`,
      );
    } finally {
      client.close();
      server.forceShutdown();
    }
  });
});
