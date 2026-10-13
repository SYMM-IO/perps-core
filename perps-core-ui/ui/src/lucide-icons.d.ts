/**
 * Each lucide icon module also exports the drawing behind its React component. The map needs that
 * drawing, because Cytoscape paints images and cannot mount a component inside a node.
 */
declare module 'lucide-react/dist/esm/icons/*.mjs' {
  export const __iconData: { name: string; size: number; node: [string, Record<string, string>][] }
}
