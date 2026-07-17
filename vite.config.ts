import { defineConfig } from 'vite';
import pkg from './package.json';

// Relative base so the production build works from any subfolder
// (GitHub Pages, Netlify, Neocities, itch.io zip, etc).
export default defineConfig({
  base: './',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  build: {
    target: 'es2020',
    sourcemap: false,
    chunkSizeWarningLimit: 1200,
  },
});
