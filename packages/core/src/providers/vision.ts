// Which models can see images. Only models known to take text alone are listed: anything else is
// sent its images, and a model that refuses them says so in its error.

/** Text-only model families by id (the last part of an "org/model" id, as OpenRouter names them). */
const TEXT_ONLY = /^(?:o1-mini|o3-mini|gpt-3\.5|gpt-oss|codestral|devstral|qwen[\d.]*-coder|deepseek-(?:chat|reasoner|coder|r1|v[23]))/i;

export function modelTakesImages(model: string): boolean {
  const id = model.slice(model.lastIndexOf('/') + 1);
  return !TEXT_ONLY.test(id);
}

/** What replaces an image for a model that cannot see. */
export const IMAGE_NOT_SENT = '[An image was attached here, but this model does not accept images, so it was not sent.]';
