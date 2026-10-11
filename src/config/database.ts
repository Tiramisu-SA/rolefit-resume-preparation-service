import mongoose from 'mongoose';
import { logger } from '../utils/logger';

export async function connectDatabase(uri: string): Promise<void> {
  mongoose.connection.on('connected', () => logger.info('MongoDB connected'));
  mongoose.connection.on('disconnected', () => logger.warn('MongoDB disconnected'));
  mongoose.connection.on('error', (err) => logger.error('MongoDB error', err));
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 5000 });
}

export async function disconnectDatabase(): Promise<void> {
  await mongoose.disconnect();
}

export function isDatabaseConnected(): boolean {
  return mongoose.connection.readyState === 1;
}

/** The URI without its credentials, safe to log: mongodb+srv://***@cluster0.example.net/db */
export function redactMongoUri(uri: string): string {
  return uri.replace(/\/\/[^@/]*@/, '//***@');
}
