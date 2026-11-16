import path from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: { '@': path.resolve(__dirname, 'src') },
  },
  test: {
    environment: 'node',
    // One temp SQLite file is shared by every suite, so files run in sequence.
    fileParallelism: false,
    globalSetup: ['./src/test/globalSetup.ts'],
    env: {
      DATABASE_URL: 'file:./test-open-bill.db',
      NODE_ENV: 'test',
    },
    testTimeout: 30000,
    hookTimeout: 60000,
  },
});
