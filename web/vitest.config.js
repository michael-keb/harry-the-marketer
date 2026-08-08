// The frontend test runner.
//
// Deliberately a *separate* config from web/vite.config.js rather than a `test`
// block added to it. The build config carries the SEO transform plugin, the
// Tailwind plugin and a dev proxy — none of which a component test needs, and
// all of which would then have to keep working under Vitest for the build to
// stay green. Splitting them means `npm run build` cannot be broken by anything
// done here.
//
// Only the React plugin is shared, because JSX has to compile the same way it
// does in the app.

import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

export default defineConfig({
  root: here,
  plugins: [react()],
  test: {
    // Components are the point, so a DOM is not optional.
    environment: 'jsdom',
    globals: true,
    setupFiles: [path.join(here, 'src/__tests__/setup.js')],
    // Tests live beside the code they cover, under src/**/__tests__/.
    include: ['src/**/*.test.{js,jsx}'],
    // A spy left installed by one file is a failure in another file that is
    // impossible to read. Reset between tests rather than trusting cleanup.
    restoreMocks: true,
    clearMocks: true,
  },
})
