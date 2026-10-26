# Resume Preparation Service API

Builds a resume tailored to one job from the seeker's own verified profile, lets the seeker edit it, pick a format
and approve it, and gives the approved resume to the Application Service. Owner: Due.

| Interface | Address | Used by | Contract |
| --- | --- | --- | --- |
| REST/JSON | `http://localhost:3006/api/*` (internal) | Web app, through the API Gateway at `http://localhost:8080/api/resumes/*` | [`openapi.yaml`](openapi.yaml) |
| gRPC | `localhost:50053` (internal) | Application Service | [`proto/resume-preparation.proto`](proto/resume-preparation.proto) |
| Health | `GET http://localhost:3006/health` | Docker Compose health check | [`openapi.yaml`](openapi.yaml) |

In Docker Compose (`rolefit-api-gateway/deploy`) the service is `resume-preparation` (REST 3006, gRPC 50053) and is
not published to the host; only the gateway is.

It owns the **Resume Draft Store** (MongoDB, database `rolefit_resume_preparation`). No other service may read it.

## Flow (BUC-2B)

1. **Generate** `POST /drafts/:jobId/generate`: reads the profile and the job, tailors them, checks grounding, saves
   the draft unapproved.
2. **Preview and edit** `GET /drafts/:jobId`, `PUT /drafts/:jobId/sections`: hide sections, rewrite bullet text.
3. **Format** `PUT /drafts/:jobId/format`: `company` (only when the job has a resume template) or `personal`.
4. **Approve** `POST /drafts/:jobId/approve`.
5. **Apply**: the Application Service calls gRPC `GetApprovedResume` and stores its own copy.

Editing, changing the format or generating again clears approval, so the seeker must approve again before applying.

## Identity

Every `/api/*` route needs a seeker.

- `AUTH_MODE=jwt` (default): `Authorization: Bearer <Supabase access token>` with `app_metadata.role = seeker`. The
  gateway keeps this header and the service verifies it again (ADR-008). No or bad token → `401 UNAUTHENTICATED`;
  other roles → `403 FORBIDDEN`. The token is forwarded to Candidate Profile and Job Posting as `authorization` gRPC
  metadata.
- `AUTH_MODE=mock`: `X-User-Id: <uuid>` instead. Local testing only; refused when `NODE_ENV=production`.

The caller's user id is also their candidate profile id. Each route works on the caller's own draft for one job.

## REST endpoints

Paths are the service's; through the gateway add `/resumes` after `/api`. Full request and response schemas are in
[`openapi.yaml`](openapi.yaml).

| Method | Service path | Gateway path | Body | Success |
| --- | --- | --- | --- | --- |
| POST | `/api/drafts/:jobId/generate` | `/api/resumes/drafts/:jobId/generate` | – | `201` ResumeDraft |
| GET | `/api/drafts/:jobId` | `/api/resumes/drafts/:jobId` | – | `200` ResumeDraft |
| PUT | `/api/drafts/:jobId/sections` | `/api/resumes/drafts/:jobId/sections` | `{ sections }` | `200` ResumeDraft |
| PUT | `/api/drafts/:jobId/format` | `/api/resumes/drafts/:jobId/format` | `{ format }` | `200` ResumeDraft |
| POST | `/api/drafts/:jobId/approve` | `/api/resumes/drafts/:jobId/approve` | – | `200` ResumeDraft |
| GET | `/api/drafts/:jobId/approved` | `/api/resumes/drafts/:jobId/approved` | – | `200` ResumeDraft |

`jobId` is the Job Posting id (`job_<ULID>`, or `job_seed_<slug>` for seed data).

```json
{
  "id": "draft_01JAB4C2D3E4F5G6H7J8K9M0NP",
  "jobId": "job_01JAB3XK9V2M8Q4R7T6W5Y0Z1N",
  "candidateId": "3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f",
  "format": "personal",
  "sections": [
    {
      "id": "experience-0",
      "kind": "experience",
      "title": "Frontend Developer · Brightline",
      "meta": "2024-06 – Present",
      "bullets": [{ "id": "experience-0-b0", "text": "Built React dashboards", "tailored": true }],
      "emphasized": true,
      "included": true
    }
  ],
  "approved": false,
  "generatedAt": "2026-10-11T09:00:00.000Z",
  "updatedAt": "2026-10-11T09:00:00.000Z"
}
```

Same shape as `ResumeDraft` in rolefit-frontend `src/lib/types.ts`. `approvedAt` is present only while approved.
Section kinds: `summary`, `skills`, `education`, `experience`, `project`. Section ids (`summary`, `skills`,
`education`, `experience-<n>`, `project-<n>`) are positions in the profile, so they stay the same when regenerating.

### Rules

- One draft per (seeker, job). Generating again keeps the draft id, rebuilds the content from the current profile and
  drops edits and approval.
- Generating needs a profile (`409 PROFILE_REQUIRED`) and an open job (`404 JOB_NOT_FOUND`, `409 JOB_NOT_OPEN`).
- The format starts as `company` when the job has a company resume template, otherwise `personal`. `company` can only
  be chosen for a job with a template (`409 NO_COMPANY_TEMPLATE`).
- Edits send back the whole `sections` list with exactly the draft's section and bullet ids. Only `included` and bullet
  `text` change; titles, dates and kinds sent by the client are ignored. A rewritten bullet gets `tailored: false`.
- Limits: at most 100 sections, 50 bullets per section, 2,000 characters per bullet; bullet text must not be empty.
- Approving needs at least one included section (`409 RESUME_EMPTY`).
- `GET /approved` answers `404 RESUME_DRAFT_NOT_FOUND` or `409 RESUME_NOT_APPROVED` until the seeker approves. It
  returns the full draft; gRPC returns only the included sections.

## Errors

Shared envelope: `{ "error": { "code", "message", "details"? } }`. `details` (`[{ field, message }]`) is sent only with
`VALIDATION_ERROR`.

| HTTP | Code | When |
| --- | --- | --- |
| 400 | `VALIDATION_ERROR` | Bad `jobId` or body |
| 400 | `MALFORMED_JSON` | Body is not valid JSON |
| 401 | `UNAUTHENTICATED` | No, bad or expired token (bad `X-User-Id` in mock mode) |
| 403 | `FORBIDDEN` | The caller is not a seeker |
| 404 | `RESUME_DRAFT_NOT_FOUND` | No draft for this job yet |
| 404 | `JOB_NOT_FOUND` | Job Posting has no such job |
| 404 | `ROUTE_NOT_FOUND` | Unknown path |
| 409 | `PROFILE_REQUIRED` | The seeker has no profile yet |
| 409 | `JOB_NOT_OPEN` | The job is a draft or closed |
| 409 | `NO_COMPANY_TEMPLATE` | `company` format for a job without a template |
| 409 | `RESUME_EMPTY` | Approving with no included section |
| 409 | `RESUME_NOT_APPROVED` | Reading the approved resume before approval |
| 500 | `INTERNAL_ERROR` | Unexpected error (details are logged, not returned) |
| 502 | `UNGROUNDED_RESUME` | The AI adapter produced content that is not in the profile; nothing is saved |
| 502 | `UPSTREAM_ERROR` | Candidate Profile or Job Posting returned an unexpected error |
| 503 | `SERVICE_UNAVAILABLE` | Candidate Profile or Job Posting is down or slower than `GRPC_DEADLINE_MS` (5 s) |

## gRPC: `GetApprovedResume` (for the Application Service)

Package `rolefit.resumepreparation.v1`, service `ResumePreparationService`. Copy
[`proto/resume-preparation.proto`](proto/resume-preparation.proto) unchanged into the caller's `proto/` folder.

```proto
rpc GetApprovedResume (GetApprovedResumeRequest) returns (GetApprovedResumeResponse);

message GetApprovedResumeRequest {
  string candidate_id = 1;  // seeker user id (UUID) = profile id
  string job_id = 2;        // job_<ULID>
}
// GetApprovedResumeResponse { ApprovedResume resume = 1; }
// ApprovedResume: draft_id, candidate_id, job_id, format (RESUME_FORMAT_COMPANY | RESUME_FORMAT_PERSONAL),
//                 sections (included ones only), approved_at, updated_at (ISO-8601)
```

| gRPC status | `x-error-code` | When |
| --- | --- | --- |
| `INVALID_ARGUMENT` | `VALIDATION_ERROR` | `candidate_id` is not a UUID or `job_id` is malformed |
| `NOT_FOUND` | `RESUME_DRAFT_NOT_FOUND` | No draft for this candidate and job |
| `FAILED_PRECONDITION` | `RESUME_NOT_APPROVED` | A draft exists but is not approved |
| `INTERNAL` | `INTERNAL_ERROR` | Unexpected error |

The RoleFit error code is sent in the `x-error-code` trailer. The gRPC handler does not verify JWTs: it trusts the
caller to pass the verified seeker id, so port 50053 must stay private (it is not published in Docker Compose).

```bash
grpcurl -plaintext -import-path proto -proto resume-preparation.proto \
  -d '{"candidate_id":"<uuid>","job_id":"job_seed_frontend"}' \
  localhost:50053 rolefit.resumepreparation.v1.ResumePreparationService/GetApprovedResume
```

## What this service calls

| Service | RPC | Why | Contract copy |
| --- | --- | --- | --- |
| Candidate Profile (`:50051`) | `GetProfile` | The seeker's verified profile, the only source of resume content | `proto/candidate-profile.proto` |
| Job Posting (`:50052`) | `GetJob` | Required and preferred skills, status, whether the job has a resume template | `proto/job-posting.proto` |

Both calls carry the caller's token as `authorization` metadata and use a `GRPC_DEADLINE_MS` deadline. The Candidate
Profile gRPC message has no summary, email or links yet, so the profile headline is used as the resume summary.

## Configuration

`PORT` (3006), `GRPC_HOST` (0.0.0.0), `GRPC_PORT` (50053), `CORS_ORIGIN`, `MONGODB_URI` (database
`rolefit_resume_preparation`), `CANDIDATE_PROFILE_GRPC_URL` (`localhost:50051`), `JOB_POSTING_GRPC_URL`
(`localhost:50052`), `GRPC_DEADLINE_MS` (5000), `AUTH_MODE` (`jwt` | `mock`), `SUPABASE_URL`,
`SUPABASE_PUBLISHABLE_KEY` (never the secret key), `AI_PROVIDER` (`rule-based`), `AI_API_KEY` (reserved for an LLM
adapter). The API Gateway reaches this service through `RESUME_PREPARATION_SERVICE_URL`. See
[`.env.example`](.env.example).

## Changing this API

Ask the owner before changing a contract. In the `.proto`, never renumber or reuse field numbers; add new fields with
new numbers. When a path, field, error code or port changes, update `openapi.yaml`, this file and the
"Resume Preparation Service API" page in Notion (Rolefit Home → RoleFit API Documentation).
