// Images in the message box: which files can be attached, and the size they are scaled down to.
// Everything happens in the page: an image is decoded and re-encoded here and goes, with the
// message, only to the provider that answers it.
import { t } from '@orka/core/src/i18n';

/** What the providers take: PNG, JPEG, GIF and WebP (anything else is refused with a notice). */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
export const MAX_IMAGES = 5;
/** A larger file is not even decoded (a photo straight from a camera is well under this). */
export const MAX_IMAGE_FILE_BYTES = 20 * 1024 * 1024;
/** Long edge sent to the model: larger images cost more tokens without helping it see more. */
export const MAX_IMAGE_EDGE = 1568;

/** Why a file cannot be attached, or undefined when it can. */
export function imageProblem(file: { name: string; type: string; size: number }): string | undefined {
  const name = file.name || t('Pasted image');
  if (!IMAGE_TYPES.includes(file.type.toLowerCase())) return t('{file} was not attached: only PNG, JPEG, GIF and WebP images can be.', { file: name });
  if (file.size > MAX_IMAGE_FILE_BYTES) return t('{file} was not attached: it is larger than {mb} MB.', { file: name, mb: MAX_IMAGE_FILE_BYTES / 1024 / 1024 });
  return undefined;
}

/** The size an image is scaled down to so that its long edge is at most `edge` (never scaled up). */
export function fitWithin(width: number, height: number, edge: number): { width: number; height: number } {
  const scale = Math.min(1, edge / Math.max(width, height, 1));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

/**
 * The files to attach out of those picked, pasted or dropped: the ones that fit while there is
 * room, and a notice for each one left out.
 */
export function pickImages<F extends { name: string; type: string; size: number }>(files: F[], already: number): { accepted: F[]; notices: string[] } {
  const notices: string[] = [];
  const accepted: F[] = [];
  for (const file of files) {
    const problem = imageProblem(file);
    if (problem) notices.push(problem);
    else if (already + accepted.length >= MAX_IMAGES) {
      notices.push(t('At most {n} images per message.', { n: MAX_IMAGES }));
      break;
    } else accepted.push(file);
  }
  return { accepted, notices };
}
