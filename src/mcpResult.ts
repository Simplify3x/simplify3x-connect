/**
 * Shared CallToolResult helpers. Lives outside server.ts so tool modules
 * (src/tools/*.ts) can import it without a circular dependency back on
 * server.ts, which itself registers those tool modules.
 */
export const err = (text: string) => ({ isError: true as const, content: [{ type: 'text' as const, text: `### Error\n${text}` }] });
export const ok = (text: string, structuredContent?: Record<string, unknown>) =>
  ({ content: [{ type: 'text' as const, text }], ...(structuredContent ? { structuredContent } : {}) });

/** `ok` plus inline images, each preceded by its caption so the reader knows what it shows. An entry
 *  without `data` is its caption only (a text note in place of a missing image). */
export const okWithImages = (
  text: string,
  images: Array<{ caption: string; data?: string; mimeType?: string }>,
  structuredContent?: Record<string, unknown>,
) => ({
  content: [
    { type: 'text' as const, text },
    ...images.flatMap((img) => [
      { type: 'text' as const, text: img.caption },
      ...(img.data !== undefined && img.mimeType !== undefined
        ? [{ type: 'image' as const, data: img.data, mimeType: img.mimeType }] : []),
    ]),
  ],
  ...(structuredContent ? { structuredContent } : {}),
});
