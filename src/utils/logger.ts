/**
 * Minimal logger wrapper. Silent under NODE_ENV=test so test output stays readable.
 */
const quiet = () => process.env.NODE_ENV === 'test';

export const logger = {
  info: (...args: unknown[]) => quiet() || console.log('[resume-preparation]', ...args),
  warn: (...args: unknown[]) => quiet() || console.warn('[resume-preparation]', ...args),
  error: (...args: unknown[]) => quiet() || console.error('[resume-preparation]', ...args),
};
