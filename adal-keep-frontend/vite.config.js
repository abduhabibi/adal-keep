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
    // `vite build --mode phone`: the pages built into the phone app
    // (adal-phone/www) for when its PC is off; connect.html finds the PC.
    mode === 'phone' && {
      name: 'adal-phone-files',
      closeBundle() {
        const out = path.resolve('../adal-phone/www')
        for (const f of fs.readdirSync('public-phone')) fs.copyFileSync(path.join('public-phone', f), path.join(out, f))
        for (const f of ['sw.js', 'manifest.webmanifest']) fs.rmSync(path.join(out, f), { force: true })
        // The online address (Supabase URL + its public anon key) and where
        // new apps are published — from the backend's .env, never committed.
        const env = Object.fromEntries((fs.existsSync('../adal-keep-backend/.env') ? fs.readFileSync('../adal-keep-backend/.env', 'utf8') : '')
          .split('\n').map(l => l.match(/^\s*([A-Z_]+)\s*=\s*(.*)\s*$/)).filter(Boolean).map(m => [m[1], m[2].replace(/^['"]|['"]$/g, '')]))
        const cfg = { url: (env.SUPABASE_URL || '').replace(/\/+$/, ''), anon: env.SUPABASE_ANON_KEY || '',
          updates: 'https://raw.githubusercontent.com/abduhabibi/adal-keep/release/adal-keep-backend/src/phone-app' }
        fs.writeFileSync(path.join(out, 'config.js'), `window.ADAL_CLOUD_CONFIG = ${JSON.stringify(cfg)}\n`)
      },
    },
  ].filter(Boolean),
  build: mode === 'demo' ? { outDir: 'dist-demo' } : mode === 'phone' ? { outDir: '../adal-phone/www', emptyOutDir: true }
    : mode === 'admin' ? { outDir: '../adal-admin/keep-app', emptyOutDir: true } : {},
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
