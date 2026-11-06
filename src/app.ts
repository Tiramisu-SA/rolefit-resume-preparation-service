import express, { type Express, type RequestHandler } from 'express';
import { ResumeController } from './controllers/resume.controller';
import { cors } from './middleware/cors.middleware';
import { errorHandler, notFoundHandler } from './middleware/error.middleware';
import { requestLogger } from './middleware/logger.middleware';
import { requestId } from './middleware/request-id.middleware';
import { createResumeRoutes } from './routes/resume.routes';
import type { ResumeService } from './services/resume.service';

export interface AppDependencies {
  resumeService: ResumeService;
  /** `identify(verifyClaims)` in JWT mode, `identifyFromHeader` in mock mode. */
  identity: RequestHandler;
  /** The web frontend origin allowed by CORS, e.g. http://localhost:3000. */
  corsOrigin: string;
  /** Reports the Resume Draft Store state on /health. */
  isDatabaseReady: () => boolean;
}

/** Builds the Express app (REST API). Does not listen on a port, which keeps it easy to test. */
export function buildApp({ resumeService, identity, corsOrigin, isDatabaseReady }: AppDependencies): Express {
  const app = express();
  app.disable('x-powered-by');

  app.use(requestId);
  app.use(cors(corsOrigin));
  app.get('/health', (_req, res) => {
    const db = isDatabaseReady() ? 'connected' : 'disconnected';
    res.status(db === 'connected' ? 200 : 503).json({ status: db === 'connected' ? 'ok' : 'degraded', service: 'resume-preparation-service', db });
  });
  // After /health, so container health checks do not flood the log.
  app.use(requestLogger);
  app.use('/api', identity);
  app.use(express.json({ limit: '1mb' }));
  app.use('/api', createResumeRoutes(new ResumeController(resumeService)));

  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
