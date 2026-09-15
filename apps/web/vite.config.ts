import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:47831',
        changeOrigin: true,
        headers: { origin: 'http://127.0.0.1:47831' },
      },
      '/auth': {
        target: 'http://127.0.0.1:47831',
        changeOrigin: true,
        headers: { origin: 'http://127.0.0.1:47831' },
      },
    },
  },
});
