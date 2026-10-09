// TextDecoder and TextEncoder are globals in browsers and Node alike, but
// only the DOM's types and Node's declare them, and this package has neither
// (tsconfig.json). As much of them as it uses.

declare class TextDecoder {
  constructor(label?: string, options?: { fatal?: boolean; ignoreBOM?: boolean })
  decode(input?: Uint8Array): string
}

declare class TextEncoder {
  encode(input?: string): Uint8Array
}
