// Bundled third-party GLB catalog removed. Map your own catalog ids to model
// filenames under static/models to make GLB loading available again.
const MODEL_FILES: Record<string, string> = {};

export function getModelFile(catalogId: string): string | null {
  return Object.hasOwn(MODEL_FILES, catalogId) ? MODEL_FILES[catalogId] : null;
}
