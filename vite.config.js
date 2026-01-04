import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// https://vitejs.dev/config/
export default defineConfig({
  plugins: [react()],

  // Critical for Electron: use relative paths for file:// protocol
  base: './',

  build: {
    outDir: 'public/dist',
    emptyOutDir: true,

    // Generate sourcemaps for debugging
    sourcemap: true,

    // Rollup options for optimization
    rollupOptions: {
      output: {
        // Manual chunking for better caching
        manualChunks: {
          'react-vendor': ['react', 'react-dom'],
          'xterm-vendor': ['xterm', 'xterm-addon-fit', 'xterm-addon-web-links']
        }
      }
    },

    // Target modern browsers (ES2020+)
    target: 'es2020'
  },

  // Development server config
  server: {
    port: 5173,
    strictPort: false,
  },

  // Resolve aliases
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src/client')
    }
  }
});
