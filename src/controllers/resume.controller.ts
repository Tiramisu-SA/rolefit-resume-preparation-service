import type { Request, Response } from 'express';
import type { Caller, ResumeService } from '../services/resume.service';
import { parseFormat, parseJobId, parseSectionEdits } from '../validation/resume.validation';

const caller = (req: Request): Caller => ({ userId: req.userId!, accessToken: req.accessToken });

/** REST transport only: parse input, call ResumeService, send JSON. Errors go to the error middleware. */
export class ResumeController {
  constructor(private readonly resumes: ResumeService) {}

  generate = async (req: Request, res: Response): Promise<void> => {
    res.status(201).json(await this.resumes.generateTailoredResume(caller(req), parseJobId(req.params.jobId)));
  };

  getDraft = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.resumes.getResumeDraft(caller(req), parseJobId(req.params.jobId)));
  };

  editSections = async (req: Request, res: Response): Promise<void> => {
    const jobId = parseJobId(req.params.jobId);
    res.json(await this.resumes.editResumeDraft(caller(req), jobId, parseSectionEdits(req.body)));
  };

  selectFormat = async (req: Request, res: Response): Promise<void> => {
    const jobId = parseJobId(req.params.jobId);
    res.json(await this.resumes.selectResumeFormat(caller(req), jobId, parseFormat(req.body)));
  };

  approve = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.resumes.approveResume(caller(req), parseJobId(req.params.jobId)));
  };

  getApproved = async (req: Request, res: Response): Promise<void> => {
    res.json(await this.resumes.getApprovedResume(req.userId!, parseJobId(req.params.jobId)));
  };
}
