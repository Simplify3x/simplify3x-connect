/**
 * Image urls of a failed step (screenshot, element thumbnail, baseline — copied or recorded):
 * made absolute on the SQA host, the same way screenshots are, and checked before anything is
 * fetched. SQA stores placeholders such as "undefined.png" when no image was taken.
 */
import { truncate } from './failureReport.js';

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp)$/i;
/** File names SQA writes when there is no image ("undefined.png", "null.png"). */
const PLACEHOLDER = /^(undefined|null|nan|none)?$/i;

/** True when the url's file name is a real image name: not a placeholder, and an image extension
 *  (or none). Pure string check — nothing is fetched. */
export function looksLikeImage(url: string): boolean {
  const path = url.split(/[?#]/)[0] ?? '';
  const file = path.slice(path.lastIndexOf('/') + 1);
  if (!file) return false;
  const dot = file.lastIndexOf('.');
  const stem = dot >= 0 ? file.slice(0, dot) : file;
  if (PLACEHOLDER.test(stem.trim())) return false;
  return dot < 0 || IMAGE_EXT.test(file);
}

/**
 * One raw image value → an absolute url on `base` (`/x` → `${base}/x`), or why it was skipped.
 * undefined for an empty value.
 */
export function normaliseImageUrl(base: string, raw: string | undefined): { url: string } | { skipped: string } | undefined {
  const v = (raw ?? '').trim();
  if (!v) return undefined;
  const abs = v.startsWith('/') ? `${base}${v}` : v;
  if (!looksLikeImage(abs)) return { skipped: `"${truncate(v, 80)}" is not an image` };
  if (!base || !abs.startsWith(`${base}/`)) return { skipped: 'not on the SQA host' };
  return { url: abs };
}
