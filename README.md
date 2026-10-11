# RoleFit – Resume Preparation Service

Builds a resume tailored to one job, using **only** the candidate's verified profile (ADR-004). The seeker
previews it, edits it, picks a format and approves it; the Application Service then reads the approved
resume when the seeker applies.

- **REST/JSON** (`:3004`) for the web app, through the API Gateway (`/api/resumes/*` → this service's `/api/*`).
- **gRPC** (`:50053`) `GetApprovedResume` for the Application Service.
- Owns the **Resume Draft Store** (MongoDB, database `rolefit_resume_preparation`). No other service may read it.
- Reads the profile from the Candidate Profile Service and the job from the Job Posting Service over gRPC.

## Quick start

```bash
npm install
cp .env.example .env   # fill SUPABASE_URL / SUPABASE_PUBLISHABLE_KEY (rolefit-auth), or set AUTH_MODE=mock
npm run dev            # REST + gRPC with auto-reload
```

Needs MongoDB (e.g. `docker run -d --name rolefit-mongo -p 27017:27017 mongo:7`) and, for generating drafts,
the Candidate Profile (`:50051`) and Job Posting (`:50052`) services. Without MongoDB the service still starts and
`/health` reports `db: disconnected`.

| Script | What it does |
| --- | --- |
| `npm run dev` | Run from TypeScript sources with auto-reload |
| `npm run build` / `npm start` | Compile to `dist/` / run the build |
| `npm run typecheck` | Type-check without emitting |
| `npm test` | Tests (node:test) with fakes; the MongoDB test runs only with `MONGODB_TEST_URI` set |

`MONGODB_TEST_URI=mongodb://localhost:27017/rolefit_resume_preparation_test npm test` also runs the repository
against a real MongoDB (the test database is dropped afterwards).

## Architecture

```
 Web app ── REST + Bearer JWT ──▶ API Gateway ── /api/resumes/* ──▶ ResumeController ─┐
                                                                                      ├─▶ ResumeService ─┬─▶ ResumeDraftRepository ─▶ MongoDB
 Application Service ── gRPC GetApprovedResume ──▶ resume-preparation.grpc.ts ────────┘                  ├─▶ CandidateProfileClient ─ gRPC GetProfile ─▶ Candidate Profile
                                                                                                          ├─▶ JobPostingClient ─ gRPC GetJob / GetResumeTemplate ─▶ Job Posting
                                                                                                          └─▶ AIModelAdapter.tailorResume() (rule-based placeholder)
```

- **Controllers / gRPC handlers** only translate input, output and errors. All rules live in `ResumeService`, shared by both.
- **AI Model Adapter** is a module, not a microservice. `RuleBasedTailorAdapter` selects and reorders the profile's own
  content: bullets that mention a required or preferred job skill are marked `tailored` and moved first, matching skills
  are listed first. It never writes new text.
- **Grounding check** (`services/grounding.ts`): every generated draft is checked against the profile before it is saved.
  Sections must point at real profile items; employer, job title, dates, project names, tech, skills and education must
  be the profile's own; no section may have more bullets than its source. Bullet *wording* is not compared, because
  ADR-004 allows rephrasing — the seeker reviews the text before approving.
- **Caller token forwarding**: in JWT mode the caller's access token is sent as `authorization` gRPC metadata, so the
  upstream services can verify who is asking (Job Posting is moving to JWT checks on every RPC).

## REST API

Every `/api/*` route needs a caller. `AUTH_MODE=jwt` (default): `Authorization: Bearer <Supabase JWT>` with
`app_metadata.role = seeker` (401 otherwise, 403 for other roles); the gateway keeps this header. `AUTH_MODE=mock`:
`X-User-Id: <uuid>` instead (local testing only). Each route works on the caller's own draft for one job.

| Method | Path (service) | Through the gateway | Operation |
| --- | --- | --- | --- |
| GET | `/health` | – | Health + MongoDB state |
| POST | `/api/drafts/:jobId/generate` | `/api/resumes/drafts/:jobId/generate` | `generateTailoredResume()` → 201 draft |
| GET | `/api/drafts/:jobId` | `/api/resumes/drafts/:jobId` | `getResumeDraft()` |
| PUT | `/api/drafts/:jobId/sections` | `/api/resumes/drafts/:jobId/sections` | `editResumeDraft()` body `{ sections }` |
| PUT | `/api/drafts/:jobId/format` | `/api/resumes/drafts/:jobId/format` | `selectResumeFormat()` body `{ format }` |
| POST | `/api/drafts/:jobId/approve` | `/api/resumes/drafts/:jobId/approve` | `approveResume()` |
| GET | `/api/drafts/:jobId/approved` | `/api/resumes/drafts/:jobId/approved` | `getApprovedResume()` |

A draft has the same shape as the web app's `ResumeDraft` (`src/lib/types.ts` in rolefit-frontend):
`{ id, jobId, candidateId, format, sections[{ id, kind, title, meta?, bullets[{ id, text, tailored }], emphasized, included }], approved, approvedAt?, generatedAt, updatedAt }`.

Rules:

- One draft per (seeker, job). Generating again rebuilds it from the current profile, keeps its id, drops edits and approval.
- Generating needs a profile (`409 PROFILE_REQUIRED`) and an open job (`409 JOB_NOT_OPEN`, `404 JOB_NOT_FOUND`).
- The default format is `company` when the job has a company resume template, otherwise `personal`.
  `company` can only be chosen for a job with a template (`409 NO_COMPANY_TEMPLATE`).
- Edits may only change each section's `included` and each bullet's `text`. The whole `sections` list is sent back;
  sections and bullets cannot be added, removed or renamed (`400 VALIDATION_ERROR`). Titles and dates sent by the
  client are ignored.
- Editing or changing the format clears approval. Approving needs at least one included section (`409 RESUME_EMPTY`).
- `getApprovedResume` answers `404 RESUME_DRAFT_NOT_FOUND` or `409 RESUME_NOT_APPROVED` until the seeker approves.

Errors use the shared envelope `{ "error": { "code", "message", "details"? } }`. Upstream outages return `503 SERVICE_UNAVAILABLE`.

## gRPC API

[`proto/resume-preparation.proto`](proto/resume-preparation.proto), package `rolefit.resumepreparation.v1`:

```proto
service ResumePreparationService {
  rpc GetApprovedResume (GetApprovedResumeRequest) returns (GetApprovedResumeResponse);
}
```

Returns the approved resume with only the included sections. `NOT_FOUND` (no draft), `FAILED_PRECONDITION`
(not approved), `INVALID_ARGUMENT` (bad ids); the error code is also in the `x-error-code` metadata. Consumers keep a
copy of the proto file.

```bash
grpcurl -plaintext -import-path proto -proto resume-preparation.proto \
  -d '{"candidate_id":"<uuid>","job_id":"job_seed_frontend"}' \
  localhost:50053 rolefit.resumepreparation.v1.ResumePreparationService/GetApprovedResume
```

## Contracts used

`proto/candidate-profile.proto` and `proto/job-posting.proto` are copies of the owning services' files (same as the Job
Discovery Service). The Candidate Profile gRPC message has no free-text summary, so the verified **headline** is used as
the resume summary for now (see TODO.md).

## Folder structure

```
proto/                 gRPC contracts (own + copies of upstream services)
src/
  server.ts            Composition root: config, MongoDB, REST + gRPC
  app.ts               Express app (buildApp), testable without a port
  config/              env.ts (validated config), database.ts (Mongoose connection)
  auth/                Supabase claims verifier
  middleware/          identity (jwt | mock), cors, error
  routes/ controllers/ REST transport
  grpc/                gRPC server + clients for Candidate Profile and Job Posting
  services/            ResumeService (business rules), grounding check
  adapters/ai/         AIModelAdapter interface + rule-based placeholder
  repositories/ models/ Resume Draft Store (MongoDB)
  validation/ types/ utils/
tests/                 node:test suites with fakes; MongoDB integration test
```
