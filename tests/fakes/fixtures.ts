import type { CandidateProfileReader } from '../../src/grpc/candidate-profile.client';
import type { JobPostingReader } from '../../src/grpc/job-posting.client';
import type { ResumeDraftRepository } from '../../src/repositories/resume-draft.repository';
import { ResumeService } from '../../src/services/resume.service';
import { RuleBasedTailorAdapter } from '../../src/adapters/ai/rule-based.adapter';
import type { CandidateProfile, JobPosting, ResumeDraft, ResumeTemplateInfo } from '../../src/types/domain.types';
import { jobNotFound } from '../../src/utils/errors';

export const SEEKER_ID = '3f1c2d4e-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
export const OTHER_SEEKER_ID = '9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d';
export const JOB_ID = 'job_01HZXREACTFRONTEND';
export const TEMPLATE_JOB_ID = 'job_01HZXWITHTEMPLATE';
export const CLOSED_JOB_ID = 'job_01HZXCLOSED';

export function makeProfile(overrides: Partial<CandidateProfile> = {}): CandidateProfile {
  return {
    id: SEEKER_ID,
    name: 'Pimchanok Srisuk',
    headline: 'Frontend developer focused on React and accessible UI',
    location: 'Bangkok, Thailand',
    verified: true,
    skills: [
      { name: 'Figma', proficiencyLevel: 'BASIC' },
      { name: 'TypeScript', proficiencyLevel: 'ADVANCED' },
      { name: 'React', proficiencyLevel: 'ADVANCED' },
      { name: 'Go', proficiencyLevel: 'BASIC' },
    ],
    experience: [
      {
        companyName: 'Brightline Analytics',
        jobTitle: 'Frontend Intern',
        startDate: '2025-06-01',
        endDate: null,
        isCurrent: true,
        bullets: [
          'Organised a good onboarding guide for new interns',
          'Built React dashboards used by 40 analysts',
        ],
      },
    ],
    education: [{ institutionName: 'Chulalongkorn University', degree: 'Bachelor', fieldOfStudy: 'Computer Engineering', gpa: 3.5, year: '2026' }],
    projects: [{ name: 'RoleFit', tech: ['TypeScript', 'Next.js'], bullets: ['Wrote typed API clients in TypeScript'] }],
    ...overrides,
  };
}

export function makeJob(overrides: Partial<JobPosting> = {}): JobPosting {
  return {
    id: JOB_ID,
    companyId: 'co-brightline',
    title: 'Frontend Developer',
    requirements: {
      requiredSkills: [{ name: 'React', level: 'INTERMEDIATE', minimumYears: 1 }],
      preferredSkills: [{ name: 'TypeScript', level: 'BASIC' }],
      minimumExperienceYears: 1,
      educationLevel: 'BACHELOR',
      acceptedFields: [],
    },
    responsibilities: ['Build UI'],
    applicationSettings: { positionsAvailable: 1, requireCoverLetter: false },
    status: 'OPEN',
    ...overrides,
  };
}

export class FakeProfiles implements CandidateProfileReader {
  profiles = new Map<string, CandidateProfile>([[SEEKER_ID, makeProfile()]]);
  tokens: (string | undefined)[] = [];
  async getProfile(candidateId: string, accessToken?: string) {
    this.tokens.push(accessToken);
    return this.profiles.get(candidateId) ?? null;
  }
}

export class FakeJobs implements JobPostingReader {
  jobs = new Map<string, JobPosting>([
    [JOB_ID, makeJob()],
    [TEMPLATE_JOB_ID, makeJob({ id: TEMPLATE_JOB_ID, applicationSettings: { positionsAvailable: 1, requireCoverLetter: false, resumeTemplateId: 'tpl_1' } })],
    [CLOSED_JOB_ID, makeJob({ id: CLOSED_JOB_ID, status: 'CLOSED' })],
  ]);
  async getJob(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) throw jobNotFound();
    return job;
  }
  async getResumeTemplate(jobId: string): Promise<ResumeTemplateInfo | null> {
    const id = this.jobs.get(jobId)?.applicationSettings.resumeTemplateId;
    return id ? { id, fileName: 'template.pdf', contentType: 'application/pdf' } : null;
  }
}

/** In-memory Resume Draft Store with the same contract as the Mongo repository. */
export class InMemoryDrafts implements ResumeDraftRepository {
  rows: ResumeDraft[] = [];
  async findByCandidateAndJob(candidateId: string, jobId: string) {
    const row = this.rows.find((d) => d.candidateId === candidateId && d.jobId === jobId);
    return row ? structuredClone(row) : null;
  }
  async save(draft: ResumeDraft) {
    const i = this.rows.findIndex((d) => d.candidateId === draft.candidateId && d.jobId === draft.jobId);
    const stored = structuredClone({ ...draft, id: i >= 0 ? this.rows[i].id : draft.id });
    if (stored.approvedAt === undefined) delete stored.approvedAt;
    if (i >= 0) this.rows[i] = stored;
    else this.rows.push(stored);
    return structuredClone(stored);
  }
}

export function makeService() {
  const drafts = new InMemoryDrafts();
  const profiles = new FakeProfiles();
  const jobs = new FakeJobs();
  let n = 0;
  let clock = Date.parse('2026-10-11T09:00:00.000Z');
  const service = new ResumeService({
    drafts,
    profiles,
    jobs,
    ai: new RuleBasedTailorAdapter(),
    now: () => new Date((clock += 1000)),
    newDraftId: () => `draft_${++n}`,
  });
  return { service, drafts, profiles, jobs };
}

export const seeker = { userId: SEEKER_ID, accessToken: 'token-abc' };
