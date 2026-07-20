import { defineConfig } from 'vite';
import { copyFileSync, existsSync, mkdirSync, readdirSync } from 'fs';
import { join } from 'path';

const staticFiles = ['manifest.json', 'organizer.html', 'organizer.css', 'background.js'];

function copyDir(src, dest) {
  if (!existsSync(dest)) mkdirSync(dest, { recursive: true });
  const entries = readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isFile()) {
      copyFileSync(join(src, entry.name), join(dest, entry.name));
    }
  }
}

function copyStaticPlugin() {
  return {
    name: 'copy-static',
    writeBundle() {
      for (const file of staticFiles) {
        copyFileSync(file, `dist/${file}`);
      }
      if (existsSync('assets')) {
        copyDir('assets', 'dist/assets');
      }
      copyFileSync('dist/organizer.js', 'organizer.js');
    },
  };
}

export default defineConfig({
  plugins: [copyStaticPlugin()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'esnext',
    minify: false,
    assetsInclude: ['**/*.glb'],
    rollupOptions: {
      input: 'organizer.src.js',
      output: {
        entryFileNames: 'organizer.js',
        format: 'es',
      },
    },
  },
});
