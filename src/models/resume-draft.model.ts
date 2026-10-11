import { Schema, model } from 'mongoose';
import { RESUME_FORMATS, SECTION_KINDS } from '../types/domain.types';

// A draft is one document: sections and bullets are embedded because they are
// always read and written together with the draft (same reasoning as ADR-006).
// This database belongs to the Resume Preparation Service only.

const bulletSchema = new Schema(
  {
    id: { type: String, required: true },
    text: { type: String, required: true },
    tailored: { type: Boolean, required: true },
  },
  { _id: false },
);

const sectionSchema = new Schema(
  {
    id: { type: String, required: true },
    kind: { type: String, enum: SECTION_KINDS, required: true },
    title: { type: String, required: true },
    meta: { type: String },
    bullets: { type: [bulletSchema], default: [] },
    emphasized: { type: Boolean, required: true },
    included: { type: Boolean, required: true },
  },
  { _id: false },
);

const resumeDraftSchema = new Schema(
  {
    _id: { type: String, required: true }, // draft_<ULID>
    candidateId: { type: String, required: true },
    jobId: { type: String, required: true },
    format: { type: String, enum: RESUME_FORMATS, required: true },
    sections: { type: [sectionSchema], default: [] },
    approved: { type: Boolean, required: true },
    approvedAt: { type: Date },
    generatedAt: { type: Date, required: true },
  },
  { collection: 'resume_drafts', timestamps: { createdAt: true, updatedAt: true }, versionKey: false },
);

resumeDraftSchema.index({ candidateId: 1, jobId: 1 }, { unique: true });

export const ResumeDraftModel = model('ResumeDraft', resumeDraftSchema);
