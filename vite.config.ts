import { defineConfig } from 'vite'

export default defineConfig({
  resolve: {
    alias: {
      // @tonejs/piano's MidiInput module imports Node's 'events' — polyfill for browser
      events: 'events',
    },
  },
})
