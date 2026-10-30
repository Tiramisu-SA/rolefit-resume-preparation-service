import type { AIModelAdapter } from './adapters/ai/ai.types';
import { FallbackTailorAdapter } from './adapters/ai/fallback.adapter';
import { GeminiTailorAdapter } from './adapters/ai/gemini.adapter';
import { createGeminiClient } from './adapters/ai/gemini.client';
import { RuleBasedTailorAdapter } from './adapters/ai/rule-based.adapter';
import { buildApp } from './app';
import { createClaimsVerifier } from './auth/supabase';
import { connectDatabase, disconnectDatabase, isDatabaseConnected, redactMongoUri } from './config/database';
import { loadConfig, type AppConfig } from './config/env';
import { CandidateProfileClient } from './grpc/candidate-profile.client';
import { JobPostingClient } from './grpc/job-posting.client';
import { startGrpcServer } from './grpc/resume-preparation.grpc';
import { identify, identifyFromHeader } from './middleware/identity.middleware';
import { MongoResumeDraftRepository } from './repositories/mongo-resume-draft.repository';
import { ResumeService } from './services/resume.service';
import { logger } from './utils/logger';

/** AI_PROVIDER=gemini: Gemini with the rule-based adapter as fallback. Otherwise rule-based only. */
function createAiAdapter(config: AppConfig): AIModelAdapter {
  const ruleBased = new RuleBasedTailorAdapter();
  if (config.aiProvider !== 'gemini') return ruleBased;
  logger.info(`AI provider: Gemini (${config.aiModel}), falling back to rule-based on errors`);
  return new FallbackTailorAdapter(new GeminiTailorAdapter(createGeminiClient({ apiKey: config.aiApiKey, model: config.aiModel })), ruleBased);
}

/** Composition root: the only place concrete classes are wired together. */
async function main(): Promise<void> {
  const config = loadConfig();

  try {
    await connectDatabase(config.mongodbUri);
  } catch (err) {
    // Keep running so /health can report it; draft operations fail with 500 until Mongo is back.
    logger.error(`Could not connect to MongoDB at ${redactMongoUri(config.mongodbUri)}:`, (err as Error).message);
  }

  const resumeService = new ResumeService({
    drafts: new MongoResumeDraftRepository(),
    profiles: new CandidateProfileClient(config.candidateProfileGrpcUrl, config.grpcDeadlineMs),
    jobs: new JobPostingClient(config.jobPostingGrpcUrl, config.grpcDeadlineMs),
    ai: createAiAdapter(config),
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
