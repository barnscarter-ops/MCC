import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const apiUrl = process.env.MAV_API_URL || 'http://localhost:3011';

export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        manualChunks: {
          echarts: ['echarts']
        }
      }
    }
  },
  server: {
    proxy: {
      '/api': {
        target: apiUrl,
        changeOrigin: true
      }
    }
  }
});
