import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite config for PWA client (mobile terminal)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const clientPort = parseInt(env.VITE_CLIENT_PORT, 10) || 5175;
  const workerDomain = env.WORKER_DOMAIN;

  return {
    plugins: [react()],

    // Use relative paths for serving from tunnel
    base: './',

    // Static assets from public folder (fonts, bip39, manifest)
    publicDir: 'public',

    build: {
      outDir: 'public/dist',
      emptyOutDir: true,
      sourcemap: true,

      rollupOptions: {
        input: {
          client: path.resolve(__dirname, 'client.html')
        },
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
            'xterm-vendor': ['xterm', 'xterm-addon-fit', 'xterm-addon-web-links']
          }
        }
      },

      target: 'es2020'
    },

    // Development server config
    server: {
      port: clientPort,
      strictPort: true,
      // Allow connections from any host (for tunnel access)
      host: true,
      cors: true,
      // Allow tunnel domains (workerDomain from .env, trycloudflare.com for quick tunnels)
      allowedHosts: ['localhost', '.trycloudflare.com', ...(workerDomain ? [`.${workerDomain}`] : [])],
      // HMR WebSocket uses a dedicated path so it can be proxied through main server
      hmr: {
        path: '/__vite_hmr'
      }
    },

    // Rewrite rules for SPA
    appType: 'mpa',

    // Resolve aliases
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    }
  };
});
