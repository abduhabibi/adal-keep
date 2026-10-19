import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs'
import path from 'path'

// `vite build --mode demo` builds the public demo (see src/demo/): the same
// app, answering its API in the browser with made-up data, into dist-demo/.
export default defineConfig(({ mode }) => ({
  plugins: [
    react(),
    mode === 'demo' && {
      name: 'adal-demo-files',
      closeBundle() {
        const out = path.resolve('dist-demo')
        fs.copyFileSync('public-demo/adal-demo-sw.js', path.join(out, 'adal-demo-sw.js'))
        // Static hosts: every page address serves the app.
        fs.copyFileSync(path.join(out, 'index.html'), path.join(out, '404.html'))
        fs.writeFileSync(path.join(out, '_redirects'), '/* /index.html 200\n')
      },
    },
  ].filter(Boolean),
  build: mode === 'demo' ? { outDir: 'dist-demo' } : {},
  server: {
    host: '0.0.0.0',
    port: 3000,
    proxy: {
      '/api': {
        target: 'http://localhost:4000',
        changeOrigin: true
      }
    }
  }
}))
