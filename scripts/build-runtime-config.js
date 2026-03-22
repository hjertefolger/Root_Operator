const fs = require('fs');
const path = require('path');
const dotenv = require('dotenv');

const rootDir = path.resolve(__dirname, '..');
const dotenvPath = path.join(rootDir, '.env');
const outputPath = path.join(rootDir, 'runtime-config.json');

if (fs.existsSync(dotenvPath)) {
  dotenv.config({ path: dotenvPath, override: false });
}

const runtimeConfig = {
  WORKER_BASE_URL: process.env.WORKER_BASE_URL || '',
  WORKER_DOMAIN: process.env.WORKER_DOMAIN || '',
  INTERNAL_PORT: process.env.INTERNAL_PORT || '22000',
  VITE_CLIENT_PORT: process.env.VITE_CLIENT_PORT || '5175',
  VITE_RENDERER_PORT: process.env.VITE_RENDERER_PORT || '5174',
};

fs.writeFileSync(outputPath, `${JSON.stringify(runtimeConfig, null, 2)}\n`, 'utf8');

const missingKeys = Object.entries(runtimeConfig)
  .filter(([key, value]) => !value && (key === 'WORKER_BASE_URL' || key === 'WORKER_DOMAIN'))
  .map(([key]) => key);

if (missingKeys.length > 0) {
  console.warn(`[build-runtime-config] Missing runtime config keys: ${missingKeys.join(', ')}`);
  console.warn('[build-runtime-config] The packaged app will build, but tunnel provisioning will not work until these values are provided.');
} else {
  console.log(`[build-runtime-config] Wrote ${outputPath}`);
}
