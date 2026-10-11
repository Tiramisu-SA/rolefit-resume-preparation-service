import { RuleBasedTailorAdapter } from './adapters/ai/rule-based.adapter';
import { buildApp } from './app';
import { createClaimsVerifier } from './auth/supabase';
import { connectDatabase, disconnectDatabase, isDatabaseConnected } from './config/database';
import { loadConfig } from './config/env';
import { CandidateProfileClient } from './grpc/candidate-profile.client';
import { JobPostingClient } from './grpc/job-posting.client';
import { startGrpcServer } from './grpc/resume-preparation.grpc';
import { identify, identifyFromHeader } from './middleware/identity.middleware';
import { MongoResumeDraftRepository } from './repositories/mongo-resume-draft.repository';
import { ResumeService } from './services/resume.service';
import { logger } from './utils/logger';

/** Composition root: the only place concrete classes are wired together. */
async function main(): Promise<void> {
  const config = loadConfig();

  try {
    await connectDatabase(config.mongodbUri);
  } catch (err) {
    // Keep running so /health can report it; draft operations fail with 500 until Mongo is back.
    logger.error(`Could not connect to MongoDB at ${config.mongodbUri}:`, (err as Error).message);
  }

  const resumeService = new ResumeService({
    drafts: new MongoResumeDraftRepository(),
    profiles: new CandidateProfileClient(config.candidateProfileGrpcUrl, config.grpcDeadlineMs),
    jobs: new JobPostingClient(config.jobPostingGrpcUrl, config.grpcDeadlineMs),
    // TODO: an LLM-backed adapter selected by AI_PROVIDER (see README, "AI Model Adapter").
    ai: new RuleBasedTailorAdapter(),
  });

  if (config.authMode === 'mock') logger.warn('AUTH_MODE=mock: trusting the X-User-Id header. Do not use this outside local development.');
  const identity =
    config.authMode === 'mock' ? identifyFromHeader : identify(createClaimsVerifier(config.supabaseUrl, config.supabasePublishableKey));

  const app = buildApp({ resumeService, identity, corsOrigin: config.corsOrigin, isDatabaseReady: isDatabaseConnected });
  const httpServer = app.listen(config.port, () => logger.info(`REST API listening on http://localhost:${config.port}`));

  const { server: grpcServer, port: grpcPort } = await startGrpcServer(resumeService, config.grpcHost, config.grpcPort);
  logger.info(`gRPC server listening on ${config.grpcHost}:${grpcPort}`);

  const shutdown = async (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    httpServer.close();
    grpcServer.tryShutdown(() => undefined);
    await disconnectDatabase();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error('Fatal startup error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
