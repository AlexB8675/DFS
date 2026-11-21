// What runs in the page (DESIGN.md §10.4): the parts of the engine that need the DOM. The pure parts are in
// `src/engine/`; nothing there imports from here, and `src/index.ts` never exports it.

export { MediaSourceSink, SinkQuotaError } from './sink.ts'
export { playStreamed } from './engine.ts'
export type { EngineStats } from './engine.ts'
