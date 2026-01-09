import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite config for PWA client (mobile terminal)
export default defineConfig({
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
    port: 5175,
    strictPort: true,
    // Allow connections from any host (for tunnel access)
    host: true,
    cors: true,
    // Allow tunnel domains
    allowedHosts: ['localhost', '.rootoperator.dev', '.trycloudflare.com'],
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
});
