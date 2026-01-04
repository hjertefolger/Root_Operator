import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite config for Electron renderer process (tray app)
export default defineConfig({
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
    port: 5174,
    strictPort: false,
  },

  // Resolve aliases - shared with client
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src')
    }
  }
});
