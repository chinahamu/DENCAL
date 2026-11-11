import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { createAuthMiddleware } from './server/auth';

function staffAuth(): Plugin {
  return {
    name: 'dencal-staff-auth',
    configureServer(server) {
      server.middlewares.use(createAuthMiddleware());
    },
    configurePreviewServer(server) {
      server.middlewares.use(createAuthMiddleware());
    },
  };
}

export default defineConfig({
  publicDir: false,
  plugins: [react(), tailwindcss(), staffAuth()],
  server: {
    host: '127.0.0.1',
    fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/server/**', '**/*.sqlite3*'] },
  },
  preview: { host: '127.0.0.1' },
});
