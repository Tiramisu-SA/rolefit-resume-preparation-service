import { ResumeDraftModel } from '../models/resume-draft.model';
import type { ResumeDraft, ResumeSection } from '../types/domain.types';
import type { ResumeDraftRepository } from './resume-draft.repository';

interface DraftDoc {
  _id: string;
  candidateId: string;
  jobId: string;
  format: ResumeDraft['format'];
  sections: ResumeSection[];
  approved: boolean;
  approvedAt?: Date | null;
  generatedAt: Date;
  updatedAt: Date;
}

/** Mongo document → domain object (`_id` → `id`, dates → ISO strings, no Mongoose types upward). */
function toDraft(doc: DraftDoc): ResumeDraft {
  return {
    id: doc._id,
    candidateId: doc.candidateId,
    jobId: doc.jobId,
    format: doc.format,
    sections: doc.sections.map((s) => ({
      id: s.id,
      kind: s.kind,
      title: s.title,
      ...(s.meta !== undefined && s.meta !== null ? { meta: s.meta } : {}),
      bullets: s.bullets.map((b) => ({ id: b.id, text: b.text, tailored: b.tailored })),
      emphasized: s.emphasized,
      included: s.included,
    })),
    approved: doc.approved,
    ...(doc.approvedAt ? { approvedAt: doc.approvedAt.toISOString() } : {}),
    generatedAt: doc.generatedAt.toISOString(),
    updatedAt: doc.updatedAt.toISOString(),
  };
}

export class MongoResumeDraftRepository implements ResumeDraftRepository {
  async findByCandidateAndJob(candidateId: string, jobId: string): Promise<ResumeDraft | null> {
    const doc = await ResumeDraftModel.findOne({ candidateId, jobId }).lean<DraftDoc>();
    return doc ? toDraft(doc) : null;
  }

  async save(draft: ResumeDraft): Promise<ResumeDraft> {
    const doc = await ResumeDraftModel.findOneAndUpdate(
      { candidateId: draft.candidateId, jobId: draft.jobId },
      {
        // _id is immutable in MongoDB: it is set once, and a regenerated draft keeps it.
        $setOnInsert: { _id: draft.id },
        $set: {
          format: draft.format,
          sections: draft.sections,
          approved: draft.approved,
          approvedAt: draft.approvedAt ? new Date(draft.approvedAt) : null,
          generatedAt: new Date(draft.generatedAt),
        },
      },
      { upsert: true, new: true, runValidators: true },
    ).lean<DraftDoc>();
    return toDraft(doc!);
  }
}
