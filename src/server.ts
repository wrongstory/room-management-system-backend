import 'dotenv/config';
import { buildApp } from './app.js';
import { loadEnv } from './config/env.js';

const env = loadEnv();
const app = await buildApp({ env });

const shutdown = async (signal: string) => {
  app.log.info({ signal }, 'Shutting down');
  await app.close();
  process.exit(0);
};

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));

await app.listen({ host: env.HOST, port: env.PORT });

