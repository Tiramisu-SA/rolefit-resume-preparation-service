import dotenv from 'dotenv';

dotenv.config({ quiet: true });

export type AuthMode = 'jwt' | 'mock';
export type AiProvider = 'rule-based';

export interface AppConfig {
  nodeEnv: string;
  /** REST API for the web frontend (reached through the API Gateway). */
  port: number;
  /** Internal gRPC API (GetApprovedResume) for the Application Service. */
  grpcHost: string;
  grpcPort: number;
  corsOrigin: string;
  /** Resume Draft Store. Owned by this service only. */
  mongodbUri: string;
  candidateProfileGrpcUrl: string;
  jobPostingGrpcUrl: string;
  grpcDeadlineMs: number;
  /**
   * 'jwt' (default): verify the Supabase access token the gateway forwards.
   * 'mock': trust the X-User-Id header, for local testing only. Not allowed in production.
   */
  authMode: AuthMode;
  supabaseUrl: string;
  supabasePublishableKey: string;
  aiProvider: AiProvider;
  aiApiKey: string;
}

function toInt(value: string | undefined, fallback: number, name: string, errors: string[]): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    errors.push(`${name} must be a positive whole number (got "${value}")`);
    return fallback;
  }
  return parsed;
}

/** Reads and validates the environment. Throws one error listing every problem. */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const errors: string[] = [];
  const nodeEnv = env.NODE_ENV?.trim() || 'development';

  const rawAuthMode = env.AUTH_MODE?.trim() || 'jwt';
  if (rawAuthMode !== 'jwt' && rawAuthMode !== 'mock') errors.push(`AUTH_MODE must be "jwt" or "mock" (got "${rawAuthMode}")`);
  const authMode: AuthMode = rawAuthMode === 'mock' ? 'mock' : 'jwt';
  if (authMode === 'mock' && nodeEnv === 'production') errors.push('AUTH_MODE=mock is not allowed when NODE_ENV=production');

  const supabaseUrl = env.SUPABASE_URL?.trim() ?? '';
  const supabasePublishableKey = env.SUPABASE_PUBLISHABLE_KEY?.trim() ?? '';
  if (authMode === 'jwt' && (!supabaseUrl || !supabasePublishableKey)) {
    errors.push('SUPABASE_URL and SUPABASE_PUBLISHABLE_KEY are required when AUTH_MODE=jwt');
  }

  const rawAi = env.AI_PROVIDER?.trim() || 'rule-based';
  if (rawAi !== 'rule-based') errors.push(`AI_PROVIDER must be "rule-based" (got "${rawAi}"); LLM providers are a TODO`);

  const config: AppConfig = {
    nodeEnv,
    port: toInt(env.PORT, 3006, 'PORT', errors),
    grpcHost: env.GRPC_HOST?.trim() || '0.0.0.0',
    grpcPort: toInt(env.GRPC_PORT, 50053, 'GRPC_PORT', errors),
    corsOrigin: env.CORS_ORIGIN?.trim() || 'http://localhost:3000',
    mongodbUri: env.MONGODB_URI?.trim() || 'mongodb://localhost:27017/rolefit_resume_preparation',
    candidateProfileGrpcUrl: env.CANDIDATE_PROFILE_GRPC_URL?.trim() || 'localhost:50051',
    jobPostingGrpcUrl: env.JOB_POSTING_GRPC_URL?.trim() || 'localhost:50052',
    grpcDeadlineMs: toInt(env.GRPC_DEADLINE_MS, 5000, 'GRPC_DEADLINE_MS', errors),
    authMode,
    supabaseUrl,
    supabasePublishableKey,
    aiProvider: 'rule-based',
    aiApiKey: env.AI_API_KEY ?? '',
  };

  if (errors.length) throw new Error(`Invalid configuration:\n- ${errors.join('\n- ')}`);
  return config;
}
