/**
 * `attachment_add` — attach a file (e.g. a screenshot shared in chat) to an epic / feature /
 * user story in SimplifyQA.
 *
 * The backend has no standalone upload endpoint: the UI uploads the file WITH the item save
 * (multipart `epicObj` / `featureObj` / `userstoryObj` + `filename1`). The adapter does the same
 * save, then reads the item's attachments back to confirm the file is there.
 */

import { readFile } from 'node:fs/promises';
import { basename, extname } from 'node:path';
import { resolveHosted } from '../defaults.js';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { AttachmentDownloadResult, AttachmentEntity } from '../adapters/simplifyqa/adapter.js';

export type AttachmentDeps = { getAdapter: () => ProviderAdapter | null };

type AttachmentWrites = {
  addAttachment: (input: {
    entityType: AttachmentEntity;
    itemId: string;
    fileName: string;
    contentType?: string | undefined;
    data: Uint8Array;
  }) => Promise<{ id?: string; name: string; attachments: Array<Record<string, unknown>> }>;
  downloadAttachments: (input: {
    entityType: AttachmentEntity;
    itemId: string;
    attachments?: string[] | undefined;
    all?: boolean | undefined;
    outDir: string;
  }) => Promise<AttachmentDownloadResult>;
  removeAttachment: (input: {
    entityType: AttachmentEntity;
    itemId: string;
    attachment: string;
  }) => Promise<{ removed: boolean; attachments: Array<Record<string, unknown>> }>;
};

const NOT_CONNECTED = 'Not connected to a product. Use qa_connect({ url, token, projectId }) first.';

const MIME_BY_EXT: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.csv': 'text/csv', '.json': 'application/json',
  '.zip': 'application/zip', '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

const MAX_BYTES = 20 * 1024 * 1024;   // the UI's attachment limit

/** A file to attach, as the tools receive it: a local path (preferred) or base64 + a name. Reads it and applies the UI's rules (named, not
 *  empty, at most 20 MB); a shared server never reads its own disk on a caller's behalf. Returns the bytes, or the reason it cannot be used. */
export async function readAttachmentSource(a: {
  filePath?: string | undefined; base64?: string | undefined; fileName?: string | undefined; contentType?: string | undefined;
}): Promise<{ name: string; data: Uint8Array; mime: string } | { error: string }> {
  let data: Uint8Array;
  let name = (a.fileName ?? '').trim();
  if (a.filePath && resolveHosted()) {
    // A shared server must never read its own disk on a caller's behalf: that would let any
    // user upload the pod's files (service-account token, environment) to where they can see them.
    return { error: 'This server cannot read files by path. Send the file content as `base64` together with `fileName`.' };
  }
  if (a.filePath) {
    data = new Uint8Array(await readFile(a.filePath));
    if (!name) name = basename(a.filePath);
  } else if (a.base64) {
    if (!name) return { error: 'Pass `fileName` together with `base64`.' };
    data = new Uint8Array(Buffer.from(a.base64.replace(/^data:[^;]+;base64,/, ''), 'base64'));
  } else {
    return { error: 'Pass the file as `filePath` (preferred) or as `base64` + `fileName`.' };
  }
  if (!name) return { error: 'The attachment needs a file name.' };
  if (data.byteLength === 0) return { error: `"${name}" is empty — nothing to upload.` };
  if (data.byteLength > MAX_BYTES) return { error: `"${name}" is ${(data.byteLength / 1048576).toFixed(1)} MB — the attachment limit is 20 MB.` };
  return { name, data, mime: a.contentType ?? MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream' };
}

export function registerAttachmentTools(server: McpServer, deps: AttachmentDeps): void {
  server.registerTool(
    'attachment_add',
    {
      title: 'Attach a file/screenshot to an epic, feature, user story or defect (SimplifyQA)',
      description:
        'Upload ONE file and attach it to an existing backlog item, then read the item\'s attachments ' +
        'back to confirm it is there (it will appear in the item\'s Attachments section in the UI). ' +
        'Pass the file as a LOCAL `filePath` (preferred — e.g. the screenshot path the user shared), ' +
        'or as `base64` + `fileName` when only the bytes are available. Max 20 MB.' +
        (resolveHosted()
          ? ' THIS SERVER IS SHARED: it cannot read files by path. Always send `base64` + `fileName`.'
          : ''),
      inputSchema: {
        entityType: z.enum(['epic', 'feature', 'userstory', 'defect']).describe('Which backlog item to attach to (a defect too).'),
        itemId: z.string().describe('Item id or business key (EP-66, FT-266, US-1326, DE-75).'),
        filePath: z.string().optional().describe('Absolute path of the file to upload (read on this machine).'),
        base64: z.string().optional().describe('File content as base64 (when there is no local path). Requires fileName.'),
        fileName: z.string().optional().describe('Name to store the attachment under (default: the file\'s own name).'),
        contentType: z.string().optional().describe('MIME type; inferred from the extension when omitted.'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ entityType, itemId, filePath, base64, fileName, contentType }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<AttachmentWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.addAttachment) return err('Attaching files is available only on a SimplifyQA connection.');
      try {
        const src = await readAttachmentSource({ filePath, base64, fileName, contentType });
        if ('error' in src) return err(src.error);
        const { name, data, mime } = src;
        const res = await adapter.addAttachment({ entityType, itemId, fileName: name, contentType: mime, data });
        const names = res.attachments.map((a) => String(a['original_name'] ?? a['name'] ?? '')).filter(Boolean);
        return ok(
          `Attached "${name}" to ${entityType} ${itemId} (${(data.byteLength / 1024).toFixed(1)} KB). ` +
          `Attachments now: ${names.join(', ') || '(none)'}`,
          { entityType, itemId, id: res.id, attached: name, attachments: res.attachments } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Could not attach the file to ${entityType} ${itemId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'attachment_delete',
    {
      title: 'Remove an attachment from an epic, feature, user story or defect (SimplifyQA)',
      description:
        'Remove ONE attachment from an existing backlog item by its id or stored/original file name, then ' +
        'read the item\'s attachments back to confirm it is gone. Use it to undo a wrong upload.',
      inputSchema: {
        entityType: z.enum(['epic', 'feature', 'userstory', 'defect']).describe('Which backlog item the attachment belongs to.'),
        itemId: z.string().describe('Item id or business key (EP-66, FT-266, US-1326, DE-75).'),
        attachment: z.string().describe('Attachment id, or its original/stored file name.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: true },
    },
    async ({ entityType, itemId, attachment }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<AttachmentWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.removeAttachment) return err('Removing attachments is available only on a SimplifyQA connection.');
      try {
        const res = await adapter.removeAttachment({ entityType, itemId, attachment });
        const names = res.attachments.map((a) => String(a['original_name'] ?? a['name'] ?? '')).filter(Boolean);
        return ok(
          `Removed "${attachment}" from ${entityType} ${itemId}. Attachments now: ${names.join(', ') || '(none)'}`,
          { entityType, itemId, removed: attachment, attachments: res.attachments } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Could not remove the attachment from ${entityType} ${itemId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );

  server.registerTool(
    'attachment_download',
    {
      title: 'Download an attachment of an epic, feature, user story or defect (SimplifyQA)',
      description:
        'DOWNLOAD attachments of an epic, feature, user story or defect from SimplifyQA to a local folder — fetched from SimplifyQA with the user\'s login ' +
        '(not copied from a local file). Pass `entityType` + `itemId` (EP-69, FT-269, US-1330, DE-75). If the item has ONE attachment it is downloaded; if it has ' +
        'SEVERAL and you pass no choice, the tool LISTS them (name, size, id) — show that list to the user and call again with `attachments` (names or ids, ' +
        'one or several) or `all:true`. `outDir` is the folder to save into (default "./exports"; created if missing). The answer gives each saved path, ' +
        'file name and size and says whether the size matches what SimplifyQA reports; an existing file is never overwritten (a " (1)" is added).' +
        (resolveHosted()
          ? ' THIS SERVER IS SHARED: it cannot save files. Tell the user to download attachments from the item in SimplifyQA.'
          : ''),
      inputSchema: {
        entityType: z.enum(['epic', 'feature', 'userstory', 'defect']).describe('Which backlog item the attachment belongs to.'),
        itemId: z.string().describe('Item id or business key (EP-69, FT-269, US-1330, DE-75).'),
        attachments: z.array(z.string()).optional().describe('Which attachments: file names or ids (one or several). Omit to be shown the list when there is more than one.'),
        all: z.boolean().optional().describe('true = download every attachment of the item.'),
        outDir: z.string().optional().describe('Folder to save into. Default "./exports".'),
      },
      annotations: { readOnlyHint: false },
    },
    async ({ entityType, itemId, attachments, all, outDir }) => {
      const adapter = deps.getAdapter() as (ProviderAdapter & Partial<AttachmentWrites>) | null;
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.downloadAttachments) return err('Downloading attachments is available only on a SimplifyQA connection.');
      // A shared server must never write to its own disk for a caller: users cannot reach those files,
      // and a caller-chosen outDir would let anyone write wherever the server process can.
      if (resolveHosted()) return err(`This server cannot save files. Download the attachments from ${entityType} ${itemId} in SimplifyQA.`);
      try {
        const res = await adapter.downloadAttachments({ entityType, itemId, ...(attachments?.length ? { attachments } : {}), ...(all ? { all } : {}), outDir: outDir ?? './exports' });
        const kb = (n?: number): string => (n === undefined ? 'size not reported' : `${n} bytes`);
        if (res.needsChoice) {
          return ok(
            `${entityType} ${itemId} has ${res.available.length} attachments:\n` +
              res.available.map((a, i) => `${i + 1}. ${a.name} (${kb(a.bytes)}, id ${a.id})`).join('\n') +
              '\nNothing was downloaded. ASK the user which to download — one, several or all — then call attachment_download again with `attachments` (names or ids) or `all:true`.',
            { needsChoice: true, available: res.available } as unknown as Record<string, unknown>,
          );
        }
        const lines = res.files.map((f) => `- ${f.path} — ${f.name}, ${f.bytes} bytes${f.sizeMatches === true ? ' (matches the size SimplifyQA reports)' : f.sizeMatches === false ? ` (SimplifyQA reports ${f.reportedBytes})` : ' (SimplifyQA reports no size)'}`);
        return ok(
          `Downloaded ${res.files.length} attachment${res.files.length === 1 ? '' : 's'} of ${entityType} ${itemId} from SimplifyQA:\n${lines.join('\n')}` +
            (res.warnings.length ? '\n' + res.warnings.map((w) => `⚠️ ${w}`).join('\n') : ''),
          { ...res } as unknown as Record<string, unknown>,
        );
      } catch (e) {
        return err(`Could not download from ${entityType} ${itemId}: ${e instanceof Error ? e.message : String(e)}`);
      }
    },
  );
}
