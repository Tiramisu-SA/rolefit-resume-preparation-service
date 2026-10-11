import * as grpc from '@grpc/grpc-js';
import { CandidateProfile, SKILL_LEVELS } from '../types/domain.types';
import { NotFoundError } from '../utils/errors';
import { callerMetadata, callUnary, fromEnum, loadProto, Msg, strings, text, UnaryCall } from './grpc.utils';

const SERVICE = 'profile';

/** What ResumeService needs from the Candidate Profile Service (lets tests pass a fake). */
export interface CandidateProfileReader {
  /** The candidate's profile, or null when they have not created one yet. */
  getProfile(candidateId: string, accessToken?: string): Promise<CandidateProfile | null>;
}

type Loaded = {
  rolefit: { candidateprofile: { v1: { CandidateProfileService: grpc.ServiceClientConstructor } } };
};

/** proto CandidateProfile (rolefit.candidateprofile.v1) → domain CandidateProfile. Same mapping as Job Discovery. */
export function toCandidateProfile(msg: Msg): CandidateProfile {
  return {
    id: msg.candidate_id,
    name: msg.name ?? '',
    headline: text(msg.headline) ?? null,
    location: text(msg.location) ?? null,
    verified: Boolean(msg.verified),
    skills: (msg.skills ?? []).map((s: Msg) => ({
      name: s.name,
      proficiencyLevel: fromEnum('', s.proficiency_level, SKILL_LEVELS) ?? null,
    })),
    experience: (msg.experience ?? []).map((e: Msg) => ({
      companyName: e.company_name,
      jobTitle: e.job_title,
      startDate: text(e.start_date) ?? null,
      endDate: text(e.end_date) ?? null,
      isCurrent: Boolean(e.is_current),
      bullets: strings(e.bullets),
    })),
    education: (msg.education ?? []).map((e: Msg) => ({
      institutionName: e.institution_name,
      degree: e.degree,
      fieldOfStudy: text(e.field_of_study) ?? null,
      gpa: e.gpa ? Number(e.gpa) : null,
      year: text(e.year) ?? null,
    })),
    projects: (msg.projects ?? []).map((p: Msg) => ({ name: p.name, tech: strings(p.tech), bullets: strings(p.bullets) })),
  };
}

export class CandidateProfileClient implements CandidateProfileReader {
  private readonly getProfileRpc: UnaryCall;

  constructor(
    address: string,
    private readonly deadlineMs: number,
  ) {
    const loaded = loadProto('candidate-profile.proto') as unknown as Loaded;
    const client = new loaded.rolefit.candidateprofile.v1.CandidateProfileService(address, grpc.credentials.createInsecure());
    this.getProfileRpc = (client as unknown as { GetProfile: UnaryCall }).GetProfile.bind(client);
  }

  async getProfile(candidateId: string, accessToken?: string): Promise<CandidateProfile | null> {
    try {
      const response = await callUnary(
        SERVICE,
        this.getProfileRpc,
        { candidate_id: candidateId },
        this.deadlineMs,
        (error) => (error.code === grpc.status.NOT_FOUND ? new NotFoundError('PROFILE_NOT_FOUND', 'Profile not found') : undefined),
        callerMetadata(accessToken),
      );
      return response.profile ? toCandidateProfile(response.profile) : null;
    } catch (error) {
      if (error instanceof NotFoundError) return null;
      throw error;
    }
  }
}
