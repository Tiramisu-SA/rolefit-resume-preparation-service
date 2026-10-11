# TODO – Resume Preparation Service

## Integration (other repos)

- **API Gateway** (`rolefit-api-gateway`): proxy `/api/resumes/*` to this service
  (`RESUME_PREPARATION_SERVICE_URL=http://localhost:3004`).
- **Web app** (`rolefit-frontend`): replace the browser mock in `src/lib/api/resume-preparation.ts` with gateway calls.
- **Application Service**: copy `proto/resume-preparation.proto` and call `GetApprovedResume` (`localhost:50053`) in
  `submitApplication()` to snapshot the approved resume.
- **Candidate Profile Service**: add `summary`, `email` and `links` to the gRPC `CandidateProfile` message (new field
  numbers, e.g. 15–17). Then use the summary instead of the headline and add a contact line.

## AI Model Adapter

- LLM-backed adapter selected by `AI_PROVIDER` (e.g. `anthropic`) with `AI_API_KEY`. Prompt rules (ADR-004): use only
  the profile JSON given; may select, reorder, shorten or rephrase; never add employers, titles, dates, skills,
  education, projects, numbers or achievements; return sections with the same ids as the input items.
  `assertGrounded` must stay on the save path; on `UNGROUNDED_RESUME` fall back to the rule-based adapter.
- Generation can take 10–20 s with an LLM (NFR): keep the web app's loading state, consider a timeout.

## Presentation

- Render the approved resume (PDF) in the chosen format: the company template file comes from Job Posting
  `GetResumeTemplate(include_content=true)`; the personal format is the seeker's default layout (UC1 step 5).

## Documentation

- ADR: "Use MongoDB for the Resume Draft Store" (draft = one nested document, read and written whole; same reasoning
  as ADR-006).
- Update the project document: operations table (11.2), data ownership (11.3), architecture diagram (11.7),
  component status (12.3).
