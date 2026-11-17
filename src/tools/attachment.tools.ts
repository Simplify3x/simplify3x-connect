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
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';

export type AttachmentDeps = { getAdapter: () => ProviderAdapter | null };

type AttachmentWrites = {
  addAttachment: (input: {
    entityType: 'epic' | 'feature' | 'userstory';
    itemId: string;
    fileName: string;
    contentType?: string | undefined;
    data: Uint8Array;
  }) => Promise<{ id?: string; name: string; attachments: Array<Record<string, unknown>> }>;
  removeAttachment: (input: {
    entityType: 'epic' | 'feature' | 'userstory';
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

export function registerAttachmentTools(server: McpServer, deps: AttachmentDeps): void {
  server.registerTool(
    'attachment_add',
    {
      title: 'Attach a file/screenshot to an epic, feature or user story (SimplifyQA)',
      description:
        'Upload ONE file and attach it to an existing backlog item, then read the item\'s attachments ' +
        'back to confirm it is there (it will appear in the item\'s Attachments section in the UI). ' +
        'Pass the file as a LOCAL `filePath` (preferred — e.g. the screenshot path the user shared), ' +
        'or as `base64` + `fileName` when only the bytes are available. Max 20 MB.',
      inputSchema: {
        entityType: z.enum(['epic', 'feature', 'userstory']).describe('Which backlog item to attach to.'),
        itemId: z.string().describe('Item id or business key (EP-66, FT-266, US-1326).'),
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
        let data: Uint8Array;
        let name = (fileName ?? '').trim();
        if (filePath) {
          data = new Uint8Array(await readFile(filePath));
          if (!name) name = basename(filePath);
        } else if (base64) {
          if (!name) return err('Pass `fileName` together with `base64`.');
          data = new Uint8Array(Buffer.from(base64.replace(/^data:[^;]+;base64,/, ''), 'base64'));
        } else {
          return err('Pass the file as `filePath` (preferred) or as `base64` + `fileName`.');
        }
        if (!name) return err('The attachment needs a file name.');
        if (data.byteLength === 0) return err(`"${name}" is empty — nothing to upload.`);
        if (data.byteLength > MAX_BYTES) return err(`"${name}" is ${(data.byteLength / 1048576).toFixed(1)} MB — the attachment limit is 20 MB.`);
        const mime = contentType ?? MIME_BY_EXT[extname(name).toLowerCase()] ?? 'application/octet-stream';
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
      title: 'Remove an attachment from an epic, feature or user story (SimplifyQA)',
      description:
        'Remove ONE attachment from an existing backlog item by its id or stored/original file name, then ' +
        'read the item\'s attachments back to confirm it is gone. Use it to undo a wrong upload.',
      inputSchema: {
        entityType: z.enum(['epic', 'feature', 'userstory']).describe('Which backlog item the attachment belongs to.'),
        itemId: z.string().describe('Item id or business key (EP-66, FT-266, US-1326).'),
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
}
