// Shared vocabulary. The upstream shapes (JobPosting, CandidateProfile) are the
// same as in the Job Discovery Service; the resume shapes match the frontend's
// lib/types.ts so the web app can use this service's responses unchanged.

export const EMPLOYMENT_TYPES = ['FULL_TIME', 'PART_TIME', 'INTERNSHIP', 'CONTRACT'] as const;
export const WORK_ARRANGEMENTS = ['ONSITE', 'HYBRID', 'REMOTE'] as const;
export const SKILL_LEVELS = ['BASIC', 'INTERMEDIATE', 'ADVANCED'] as const;
export const EDUCATION_LEVELS = ['NONE', 'HIGH_SCHOOL', 'DIPLOMA', 'BACHELOR', 'MASTER', 'DOCTORATE'] as const;
export const JOB_STATUSES = ['DRAFT', 'OPEN', 'CLOSED'] as const;

export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];
export type WorkArrangement = (typeof WORK_ARRANGEMENTS)[number];
export type SkillLevel = (typeof SKILL_LEVELS)[number];
export type EducationLevel = (typeof EDUCATION_LEVELS)[number];
export type JobStatus = (typeof JOB_STATUSES)[number];

// --- Job Posting Service (gRPC rolefit.jobposting.v1) ---------------------------

export interface RequiredSkill {
  name: string;
  level: SkillLevel;
  minimumYears: number;
}

export interface PreferredSkill {
  name: string;
  level: SkillLevel;
}

export interface JobRequirements {
  requiredSkills: RequiredSkill[];
  preferredSkills: PreferredSkill[];
  minimumExperienceYears: number;
  educationLevel: EducationLevel;
  acceptedFields: string[];
}

export interface ApplicationSettings {
  applicationDeadline?: string;
  positionsAvailable: number;
  /** Set when the recruiter attached a company resume template. */
  resumeTemplateId?: string;
  requireCoverLetter: boolean;
}

/** The parts of a job this service uses. */
export interface JobPosting {
  id: string;
  companyId: string;
  title: string;
  requirements: JobRequirements;
  responsibilities: string[];
  applicationSettings: ApplicationSettings;
  status: JobStatus;
}

/** Metadata of a job's company resume template (the file itself stays in the Job Posting Service). */
export interface ResumeTemplateInfo {
  id: string;
  fileName: string;
  contentType: string;
}

// --- Candidate Profile Service (gRPC rolefit.candidateprofile.v1) ---------------
// The gRPC message is a read-only view: no child ids, email, summary or links.

export interface Skill {
  name: string;
  proficiencyLevel: SkillLevel | null;
}

export interface Experience {
  companyName: string;
  jobTitle: string;
  /** YYYY-MM-DD */
  startDate: string | null;
  /** YYYY-MM-DD */
  endDate: string | null;
  isCurrent: boolean;
  bullets: string[];
}

export interface Education {
  institutionName: string;
  degree: string;
  fieldOfStudy: string | null;
  gpa: number | null;
  /** YYYY */
  year: string | null;
}

export interface Project {
  name: string;
  tech: string[];
  bullets: string[];
}

export interface CandidateProfile {
  /** Also the owner's user id. */
  id: string;
  name: string;
  headline: string | null;
  location: string | null;
  verified: boolean;
  skills: Skill[];
  experience: Experience[];
  education: Education[];
  projects: Project[];
}

// --- Resume Preparation (this service) -------------------------------------------

export const RESUME_FORMATS = ['company', 'personal'] as const;
export type ResumeFormat = (typeof RESUME_FORMATS)[number];

export const SECTION_KINDS = ['summary', 'experience', 'project', 'skills', 'education'] as const;
export type SectionKind = (typeof SECTION_KINDS)[number];

export interface ResumeBullet {
  id: string;
  text: string;
  /** True when the bullet was picked because it matches the job. */
  tailored: boolean;
}

export interface ResumeSection {
  id: string;
  kind: SectionKind;
  title: string;
  meta?: string;
  bullets: ResumeBullet[];
  emphasized: boolean;
  included: boolean;
}

export interface ResumeDraft {
  id: string;
  jobId: string;
  candidateId: string;
  format: ResumeFormat;
  sections: ResumeSection[];
  approved: boolean;
  approvedAt?: string;
  generatedAt: string;
  updatedAt: string;
}
