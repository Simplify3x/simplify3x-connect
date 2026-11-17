/**
 * Acceptance-criteria normalisation, shared by the SQA mapper (story read) and `story_sync_testcases`
 * (drift detection) so both see the SAME criteria list.
 *
 * SQA stores `acceptanceCriteria` as ONE rich-text/HTML blob
 * (`<p><strong>AC1 - ...</strong><br>Given ...</p><p><strong>AC2 - ...`) or as an array whose items can
 * each be such a blob (often `<ul><li>...</li></ul>`). Treating the blob as a single criterion made
 * story-sync report one giant `ac_added` plus every real step as `ac_removed` — a false "major" drift
 * on every linked test case (US-897 / US-941). Strip the markup, break on block boundaries, split lines.
 */
export function splitAcceptanceCriteria(raw: unknown): string[] {
  const one = (v: unknown): string[] => {
    const text0 = typeof v === 'string' ? v : String((v as any)?.description ?? v ?? '');
    if (!text0) return [];
    let text = text0;
    if (/<[a-z][^>]*>/i.test(text)) {
      text = text
        // A <br> is a soft break INSIDE one criterion (Given…/When…/Then…) → keep it in the same
        // criterion. Only BLOCK boundaries start a new AC.
        .replace(/<br\s*\/?>/gi, ' ')
        .replace(/<li\b[^>]*>/gi, '\n')
        .replace(/<\/(p|li|div|h[1-6]|tr|ul|ol|section)>/gi, '\n')
        .replace(/<[^>]+>/g, '');
    }
    text = text
      .replace(/&nbsp;/gi, ' ')
      .replace(/&amp;/gi, '&')
      .replace(/&lt;/gi, '<')
      .replace(/&gt;/gi, '>')
      .replace(/&quot;/gi, '"')
      .replace(/&#0*39;|&apos;/gi, "'");
    return text
      .split(/\r?\n/)
      .map((s) => s.replace(/[ \t]+/g, ' ').trim())
      .filter((s) => s.length > 0);
  };
  if (Array.isArray(raw)) return raw.flatMap(one);
  if (raw == null) return [];
  return one(raw);
}
