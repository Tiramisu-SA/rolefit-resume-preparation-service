import { Router } from 'express';
import type { ResumeController } from '../controllers/resume.controller';

/**
 * Mounted at /api, behind the identity middleware. Every route works on the
 * caller's own draft for one job. Through the API Gateway these are
 * /api/resumes/drafts/... (the gateway strips /resumes).
 */
export function createResumeRoutes(controller: ResumeController): Router {
  const router = Router();

  router.post('/drafts/:jobId/generate', controller.generate); // generateTailoredResume()
  router.get('/drafts/:jobId', controller.getDraft); // getResumeDraft()
  router.put('/drafts/:jobId/sections', controller.editSections); // editResumeDraft()
  router.put('/drafts/:jobId/format', controller.selectFormat); // selectResumeFormat()
  router.post('/drafts/:jobId/approve', controller.approve); // approveResume()
  router.get('/drafts/:jobId/approved', controller.getApproved); // getApprovedResume()

  return router;
}
