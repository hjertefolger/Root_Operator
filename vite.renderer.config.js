import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite config for Electron renderer process (tray app)
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  const rendererPort = parseInt(env.VITE_RENDERER_PORT, 10) || 5174;

  return {
    plugins: [react()],

    // Critical for Electron: use relative paths for file:// protocol
    base: './',

    // Public directory for static assets (fonts, etc.)
    publicDir: 'public',

    build: {
      outDir: 'ui/dist',
      emptyOutDir: true,
      sourcemap: true,

      rollupOptions: {
        input: {
          renderer: path.resolve(__dirname, 'renderer.html')
        },
        output: {
          manualChunks: {
            'react-vendor': ['react', 'react-dom'],
          }
        }
      },

      target: 'es2020'
    },

    // Development server config
    server: {
      port: rendererPort,
      strictPort: false,
    },

    // Resolve aliases - shared with client
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src')
      }
    }
  };
});
