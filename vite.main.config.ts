import { defineConfig } from 'vite';

// https://vitejs.dev/config
export default defineConfig({
  build: {
    rollupOptions: {
      external: [
        'electron',
        'electron-store',
        'pdf2json',
        '@cherrystudio/mac-system-ocr',
        'pdf-to-png-converter',
        'openai',
        'chokidar',
        'dotenv'
      ]
    }
  }
});