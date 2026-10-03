/**
 * True when the API is mocked in the browser (dev only, see `src/mocks`).
 * Set `VITE_API_MOCKS=off` to talk to a real API on localhost:3000 instead.
 */
export const mocksEnabled = import.meta.env.DEV && import.meta.env.VITE_API_MOCKS !== 'off'
