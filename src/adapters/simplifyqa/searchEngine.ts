/**
 * Generic SQA query engine — the implementation behind the single `sqa_query` tool.
 *
 * Responsibilities:
 *  - resolve a collection alias to its registry entry
 *  - validate fields/operators (the backend silently ignores unknown columns, so we must not)
 *  - inject `deleted:false` + the active project scope on every read
 *  - resolve custom-field names -> `customFields.<key>` via `/pm/fields/{parentId}`
 *  - compile `where`/`sort`/`select` into the SQA `searchFields` payload
 *  - normalize `{ totalCount, data }` and paginate with `skipStartIndex` (row offset, not page)
 */

import type { QaHttp } from '../http.js';
import { notDeleted, pickArray, str, numericId } from './mapper.js';
import {
  dateWindow, IST_OFFSET_MINUTES, latestById, matchEnumWord, matchLifecycleWord, matchNamed, matchPeople,
  normaliseCode, personQuery, SELF_WORDS, spellings, toLifecycleOptions, VERSION_RANK_FIELDS,
  type LifecycleOption, type NamedRecord, type Person,
} from './searchResolve.js';
import { childrenOf, descendants, folderStats, memberIds } from './planTree.js';
import { mapLimit } from './mapLimit.js';
import {
  resolveCollection,
  SQA_COLLECTIONS,
  type SqaCollection,
  type SqaField,
  type SqaFieldType,
  type SqaOp,
  type SqaRelation,
} from './searchRegistry.js';

export type SqaWhere = {
  field: string;
  op?: SqaOp;
  value?: string | number | boolean | Array<string | number>;
  /** Resolve `field` against the collection's custom fields (label/key). */
  custom?: boolean;
  condition?: 'and' | 'or';
};

export type SqaSort = { field: string; dir?: 'asc' | 'desc' | undefined };

export type SqaQueryRequest = {
  op: 'catalog' | 'search' | 'get' | 'related' | 'custom_fields' | 'count';
  /** op:"count" — break the count down by this field. */
  groupBy?: string;
  /** Include rows the product hides by default (obsolete test cases). */
  includeHidden?: boolean;
  /** Return every version row of a versioned entity instead of one per id. */
  allVersions?: boolean;
  collection?: string;
  where?: SqaWhere[];
  select?: string[];
  sort?: SqaSort[];
  limit?: number;
  offset?: number;
  id?: string;
  relation?: string;
  expand?: string[];
  name?: string;
  versionId?: string;
  dryRun?: boolean;
  /** Releases / sprints / epics / features: read across all your projects instead of the active one
   *  (search and count only). The adapter turns this into `scopeProjectIds`. */
  allProjects?: boolean;
  /** Internal, set by the adapter only: the project ids that replace the active-project scope for
   *  `projectIds`- and `release`-scoped collections. Never taken from the caller. */
  scopeProjectIds?: number[];
  /** Internal, set by the adapter only (an ADMIN with allProjects): no project / release scope at
   *  all — every row in the account, as an admin sees it in the UI. Never taken from the caller. */
  scopeAll?: boolean;
};

export type SqaRow = Record<string, unknown>;

export type SqaSearchResult = {
  collection: string;
  rows: SqaRow[];
  totalCount?: number;
  returned: number;
  offset: number;
  nextOffset?: number;
  payload?: Record<string, unknown>;
  /** Filter words that were translated to stored values (value resolution on). */
  resolved?: SqaResolution[];
  /** Version rows folded into their entity on this page (versioned collections). */
  collapsedVersions?: number;
  /** True when `totalCount` counts stored version rows, not items (versioned collections, partial
   *  page) — `op:"count"` gives the item count. */
  totalCountIsRows?: boolean;
  /** Set by the adapter when the scope is not the active project (allProjects). */
  scopeNote?: string;
};

/** op:"count" — a total, optionally broken down by one field. */
export type SqaCountResult = {
  collection: string;
  total: number;
  /** True when the total could not be made exact (versioned rows past the scan cap). */
  approximate?: boolean;
  groupBy?: string;
  groups?: Array<{ value: string; label: string; count: number }>;
  /** Rows read to build the breakdown, when it was built by reading rows. */
  scanned?: number;
  resolved?: SqaResolution[];
  /** Set by the adapter when the scope is not the active project (allProjects). */
  scopeNote?: string;
};

/** One translated filter: what was asked → what is stored. */
export type SqaResolution = { field: string; from: string[]; to: string[] };

export type SqaCustomField = {
  key: string;
  label: string;
  originalLabel?: string;
  column: string;
  fieldType: string;
  controlType?: string;
  mandatory?: boolean;
  values?: Array<{ key?: string; value?: string }>;
};

export type SqaCatalogEntry = {
  name: string;
  aliases: string[];
  description: string;
  usedFor: string;
  parentId?: number;
  searchPath: string;
  getPath?: string;
  scope: SqaCollection['scope'];
  idField: string;
  keyField?: string;
  labelField: string;
  defaultSelect: string[];
  fields: Array<{ key: string; type: string; ops: SqaOp[]; label?: string }>;
  relations: Array<{ name: string; kind: string; to?: string; description: string }>;
};

export type SqaQueryResult =
  | { op: 'catalog'; collections: SqaCatalogEntry[] }
  | { op: 'custom_fields'; collection: string; fields: SqaCustomField[] }
  | ({ op: 'search' | 'related' } & SqaSearchResult)
  | ({ op: 'count' } & SqaCountResult)
  | { op: 'get'; collection: string; row: SqaRow; expanded?: Record<string, unknown> };

const DEFAULT_LIMIT = 50;
const HARD_LIMIT = 500;
/** op:"count" — rows read at most when a breakdown has to be built from rows (10 calls). */
const COUNT_SCAN_CAP = 5000;
/** op:"count" — a groupBy with more configured values than this is counted from rows instead. */
const MAX_VALUE_COUNTS = 30;
const COUNT_CONCURRENCY = 5;
/** Groups returned, largest first. */
const MAX_GROUPS = 50;
/** Folders read for a folder tree (test plans). */
const MAX_FOLDERS = 2000;
/** Users read for name lookups and display names (the directory is customer-wide). */
const MAX_USERS = 10_000;
const MAX_RELEASES = 10_000;
/** How long a reference lookup (users, releases, sprints) is reused before it is read again. */
const REF_TTL_MS = 5 * 60_000;

/** Largest first, "(unset)" last, capped at MAX_GROUPS. */
function sortGroups<T extends { value: string; count: number }>(groups: T[]): T[] {
  return [...groups]
    .sort((a, b) => (a.value === '') !== (b.value === '') ? (a.value === '' ? 1 : -1) : b.count - a.count)
    .slice(0, MAX_GROUPS);
}

function fail(msg: string): never {
  throw new Error(msg);
}

function asArray(raw: unknown): SqaRow[] {
  const rows = pickArray(raw, 'data', 'content');
  return rows.filter((r): r is SqaRow => !!r && typeof r === 'object' && !Array.isArray(r));
}

function totalOf(raw: unknown, rows: SqaRow[]): number | undefined {
  const t = (raw as { totalCount?: unknown } | null)?.totalCount;
  return typeof t === 'number' ? t : rows.length;
}

function unwrapOne(raw: unknown): SqaRow {
  const doc = (raw as { data?: unknown } | null)?.data ?? raw;
  if (Array.isArray(doc)) {
    const first = doc[0];
    return first && typeof first === 'object' ? (first as SqaRow) : {};
  }
  return doc && typeof doc === 'object' ? (doc as SqaRow) : {};
}

/** Every value a row holds for a field: scalars, arrays, and `obj.field` over an array of objects. */
function valuesAt(row: SqaRow, key: string): Array<string | number> {
  const keep = (v: unknown): v is string | number => (typeof v === 'string' && v !== '') || typeof v === 'number';
  const dot = key.indexOf('.');
  if (dot >= 0) {
    const head = row[key.slice(0, dot)];
    const tail = key.slice(dot + 1);
    const list = Array.isArray(head) ? head : head && typeof head === 'object' ? [head] : [];
    return list.map((e) => (e && typeof e === 'object' ? (e as SqaRow)[tail] : undefined)).filter(keep);
  }
  const v = row[key];
  return Array.isArray(v) ? v.filter(keep) : keep(v) ? [v] : [];
}

/** `array[].field` support for `through` relations. */
function pluckPath(row: SqaRow, path: string): Array<string | number> {
  const marker = '[].';
  const idx = path.indexOf(marker);
  if (idx >= 0) {
    const head = path.slice(0, idx);
    const tail = path.slice(idx + marker.length);
    const value = row[head];
    if (!Array.isArray(value)) return [];
    return value
      .map((entry) => (entry && typeof entry === 'object' ? (entry as SqaRow)[tail] : undefined))
      .filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  }
  const value = row[path];
  if (Array.isArray(value)) {
    return value.filter((v): v is string | number => typeof v === 'string' || typeof v === 'number');
  }
  return value === undefined || value === null ? [] : [value as string | number];
}

function versionIdFromRow(row: SqaRow): string | undefined {
  const direct = str(row, 'versionId', 'selectedVersionId');
  if (direct) return direct;
  const details = row['versionsDetails'];
  if (details && typeof details === 'object') {
    const v = str(details, 'id', '_id', 'versionId');
    if (v) return v;
  }
  const versions = row['versions'];
  if (Array.isArray(versions) && versions.length) return str(versions[0], 'id', '_id');
  return undefined;
}

export type SqaEngineOptions = {
  /** Translate filter words to stored values (state "New" → its configured key, tcType "web" →
   *  "WEB"). Off = every value is sent exactly as given (the pre-resolution behaviour). */
  resolveValues?: boolean;
  /** The session user — what "me" means in a person filter. */
  currentUserId?: number;
};

/** Value resolution is on by default; `QA_MCP_SQA_RESOLVE=off|0|false|no` turns it off (kill switch). */
export function resolveValuesFromEnv(env: NodeJS.ProcessEnv): boolean {
  return !/^(off|0|false|no)$/i.test((env['QA_MCP_SQA_RESOLVE'] ?? '').trim());
}

export class SqaSearchEngine {
  private readonly customFieldCache = new Map<string, Promise<SqaCustomField[]>>();
  private readonly fieldRowsCache = new Map<string, Promise<Array<Record<string, unknown>>>>();
  /** Reference lookups (users, a project's releases/sprints), reused for REF_TTL_MS so a record
   *  created mid-session resolves soon after; failures are not kept. */
  private readonly refCache = new Map<string, { at: number; value: Promise<unknown> }>();

  constructor(
    private readonly http: QaHttp,
    private readonly projectId: number,
    private readonly options: SqaEngineOptions = {},
  ) {}

  get resolvesValues(): boolean {
    return this.options.resolveValues === true;
  }

  // ------------------------------------------------------------------ catalog

  catalog(collection?: string): SqaCatalogEntry[] {
    const names = collection
      ? [this.requireCollection(collection).name]
      : Object.keys(SQA_COLLECTIONS);
    return names.map((name) => {
      const c = SQA_COLLECTIONS[name]!;
      return {
        name: c.name,
        aliases: c.aliases,
        description: c.description,
        usedFor: c.usedFor,
        ...(c.parentId !== undefined ? { parentId: c.parentId } : {}),
        searchPath: c.searchPath,
        ...(c.getPath ? { getPath: c.getPath } : {}),
        scope: c.scope,
        idField: c.idField,
        ...(c.keyField ? { keyField: c.keyField } : {}),
        labelField: c.labelField,
        defaultSelect: c.defaultSelect,
        fields: Object.values(c.fields).map((f) => ({
          key: f.key,
          type: f.type,
          ops: f.ops,
          ...(f.label ? { label: f.label } : {}),
        })),
        relations: Object.entries(c.relations ?? {}).map(([rel, r]) => ({
          name: rel,
          kind: r.kind,
          ...(r.to ? { to: r.to } : {}),
          description: r.description,
        })),
      };
    });
  }

  // ------------------------------------------------------------- custom fields

  /** Every field row (default + custom) for a collection's parentId — one cached call that serves
   *  both custom-field resolution and lifecycle options. A failed read is not cached. */
  private fieldRows(c: SqaCollection): Promise<Array<Record<string, unknown>>> {
    const cacheKey = `${this.projectId}:${c.parentId}`;
    const cached = this.fieldRowsCache.get(cacheKey);
    if (cached) return cached;
    const promise = (async () => {
      const raw = await this.http.getJson<unknown>(
        `/pm/fields/${c.parentId}?fieldType=allFields&projectId=${this.projectId}`,
      );
      const rows = Array.isArray(raw)
        ? raw
        : Array.isArray((raw as { data?: unknown }).data)
          ? ((raw as { data: unknown[] }).data)
          : [];
      return rows.filter((r): r is Record<string, unknown> => !!r && typeof r === 'object');
    })();
    this.fieldRowsCache.set(cacheKey, promise);
    promise.catch(() => this.fieldRowsCache.delete(cacheKey));
    return promise;
  }

  /** The configured options of one default field (state / priority / severity). */
  private async lifecycleOptions(c: SqaCollection, key: string): Promise<LifecycleOption[]> {
    if (c.parentId === undefined) return [];
    const row = (await this.fieldRows(c)).find((r) => String(r['fieldType'] ?? '') === 'defaultFld' && r['key'] === key);
    return toLifecycleOptions(row?.['values']);
  }

  async customFields(collection: string): Promise<SqaCustomField[]> {
    const c = this.requireCollection(collection);
    if (c.parentId === undefined) return [];
    const cached = this.customFieldCache.get(`${this.projectId}:${c.parentId}`);
    if (cached) return cached;
    const promise = (async () => {
      const rows = await this.fieldRows(c);
      return rows
        .filter((r) => String(r['fieldType'] ?? '') !== 'defaultFld')
        .map((r): SqaCustomField => {
          const key = String(r['key'] ?? '');
          const label = String(r['label'] ?? r['originalLabel'] ?? key);
          const values = Array.isArray(r['values'])
            ? (r['values'] as Array<Record<string, unknown>>).map((v) => ({
                ...(v['key'] !== undefined ? { key: String(v['key']) } : {}),
                ...(v['value'] !== undefined ? { value: String(v['value']) } : {}),
              }))
            : undefined;
          return {
            key,
            label,
            ...(r['originalLabel'] !== undefined ? { originalLabel: String(r['originalLabel']) } : {}),
            column: `customFields.${key}`,
            fieldType: String(r['fieldType'] ?? 'customFld'),
            ...(r['controlType'] !== undefined ? { controlType: String(r['controlType']) } : {}),
            ...(typeof r['mandatory'] === 'boolean' ? { mandatory: r['mandatory'] } : {}),
            ...(values && values.length ? { values } : {}),
          };
        })
        .filter((f) => !!f.key);
    })();
    this.customFieldCache.set(`${this.projectId}:${c.parentId}`, promise);
    try {
      return await promise;
    } catch (e) {
      this.customFieldCache.delete(`${this.projectId}:${c.parentId}`);
      throw e;
    }
  }

  async resolveCustomField(collection: string, name: string): Promise<SqaCustomField> {
    const all = await this.customFields(collection);
    if (!all.length) {
      fail(`Collection "${collection}" has no custom fields configured in this project.`);
    }
    const needle = name.trim().toLowerCase();
    const matches = all.filter((f) =>
      f.label.trim().toLowerCase() === needle
      || f.key.trim().toLowerCase() === needle
      || (f.originalLabel ?? '').trim().toLowerCase() === needle
      || f.column.toLowerCase() === needle,
    );
    if (!matches.length) {
      fail(
        `Custom field "${name}" not found on ${collection}. Available: ` +
          all.map((f) => f.label).join(', '),
      );
    }
    if (matches.length > 1) {
      fail(
        `Custom field "${name}" is ambiguous on ${collection}: ` +
          matches.map((f) => `${f.label} (${f.key})`).join(', ') +
          '. Use the exact key or a more specific label.',
      );
    }
    return matches[0]!;
  }

  // -------------------------------------------------------------- search/related

  async search(req: SqaQueryRequest): Promise<SqaSearchResult> {
    const c = this.requireCollection(req.collection);
    const offset = Math.max(0, req.offset ?? 0);
    const limit = Math.min(Math.max(1, req.limit ?? DEFAULT_LIMIT), c.maxLimit ?? HARD_LIMIT);

    if (c.method === 'GET') return this.searchGet(c, req, offset, limit);

    const resolutions: SqaResolution[] = [];
    const payload = await this.compile(c, req, offset, limit, resolutions);
    const resolved = resolutions.length ? { resolved: resolutions } : {};
    const collapse = this.resolvesValues && c.versioned === true && !req.allVersions;
    if (collapse && Array.isArray(payload['selectFields'])) {
      // The rank fields decide which version row is the entity.
      payload['selectFields'] = [...new Set([...(payload['selectFields'] as string[]), 'id', ...VERSION_RANK_FIELDS])];
    }
    if (req.dryRun) {
      return { collection: c.name, rows: [], returned: 0, offset, payload, ...resolved };
    }
    const raw = await this.http.postJson<unknown>(c.searchPath, payload);
    const fetched = asArray(raw);
    // Paging stays in stored rows (nextOffset is exact); a page may hold fewer entities than rows
    // when versions of one entity sit on it.
    const rows = collapse ? latestById(fetched) : fetched;
    if (this.resolvesValues) await this.decorate(c, rows);
    const rawTotal = totalOf(raw, fetched);
    const nextOffset = typeof rawTotal === 'number' && rawTotal > offset + fetched.length
      ? offset + fetched.length
      : undefined;
    // The backend counts stored rows. With versions collapsed that is the item count only when this
    // page holds every row; otherwise it is flagged so it is never read as a number of items.
    const wholeSet = offset === 0 && nextOffset === undefined;
    const totalCount = collapse && wholeSet ? rows.length : rawTotal;
    const totalIsRows = collapse && !wholeSet && rawTotal !== undefined;
    return {
      collection: c.name,
      rows,
      ...(totalCount !== undefined ? { totalCount } : {}),
      ...(totalIsRows ? { totalCountIsRows: true } : {}),
      returned: rows.length,
      offset,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
      ...(fetched.length > rows.length ? { collapsedVersions: fetched.length - rows.length } : {}),
      ...resolved,
    };
  }

  async related(req: SqaQueryRequest): Promise<SqaSearchResult> {
    const c = this.requireCollection(req.collection);
    const relName = req.relation ?? fail('`relation` is required for op:"related".');
    const rel = c.relations?.[relName];
    if (!rel) {
      fail(
        `Unknown relation "${relName}" on ${c.name}. Available: ` +
          (c.relations ? Object.keys(c.relations).join(', ') : 'none'),
      );
    }
    const id = req.id ?? fail('`id` is required for op:"related".');
    // The parent is read first, through the soft-delete rule: a deleted record has no related rows
    // (its steps, its test cases …) — `get` reports it as not found, as the AI assistant does.
    const parent = await this.get(c.name, id);
    if (rel.kind === 'subresource') {
      const rows = await this.fetchSubresource(c, rel, id, req.versionId, parent);
      return { collection: rel.to ?? c.name, rows, totalCount: rows.length, returned: rows.length, offset: 0 };
    }
    if (rel.kind === 'query') {
      const target = rel.to ?? fail(`Relation ${relName} has no target.`);
      // Use the PARENT ROW's value for `localField`, not the caller's raw `id`: `id` may be a
      // business key ("US-947") while the remote column stores the numeric id, so passing it through
      // silently matched nothing (e.g. stories → attachments). `pluckPath` returns an array, hence
      // `[0]` for the scalar case; `arrayContains` wants the whole list.
      const localValues = pluckPath(parent, rel.localField);
      const localValue = rel.arrayContains
        ? (localValues.length ? localValues : [id])
        : localValues[0] ?? id;
      const where: SqaWhere[] = [
        ...Object.entries(rel.where ?? {}).map(([field, value]) => ({ field, op: 'eq' as const, value })),
        {
          field: rel.remoteField ?? fail(`Relation ${relName} has no remoteField.`),
          op: rel.arrayContains ? 'in' : 'eq',
          value: localValue,
        },
        ...(req.where ?? []),
      ];
      const out = await this.search({
        ...req,
        op: 'search',
        collection: target,
        where,
      });
      return out;
    }
    // through: extract the parent's local ids, query the target
    let ids = pluckPath(parent, rel.localField);
    if (rel.tree) {
      // Folder trees: sub-folders come from both edge directions; 'subtree' also gathers the
      // members filed in every folder below this one (a plan often holds nothing directly).
      const folders = await this.allFolders(c);
      const self = Number(parent['id'] ?? numericId(id));
      const children = childrenOf(folders);
      if (rel.tree === 'children') {
        ids = children.get(self) ?? [];
      } else {
        const scope = new Set([self, ...descendants(self, children)]);
        const field = rel.localField.replace('[].id', '');
        ids = [...new Set(folders.filter((f) => scope.has(Number(f['id']))).flatMap((f) => memberIds(f[field])))];
      }
    }
    if (!ids.length) {
      return { collection: rel.to ?? c.name, rows: [], totalCount: 0, returned: 0, offset: 0 };
    }
    const targetName = rel.to ?? fail(`Relation ${relName} has no target.`);
    const target = this.requireCollection(targetName);
    const out = await this.search({
      ...req,
      op: 'search',
      collection: targetName,
      where: [
        { field: target.idField, op: 'in', value: ids },
        ...(req.where ?? []),
      ],
    });
    return out;
  }

  // ---------------------------------------------------------------------- get

  async get(collection: string, id: string): Promise<SqaRow> {
    const c = this.requireCollection(collection);
    const idType = c.fields[c.idField]?.type;
    if (c.getPath) {
      let lookup = id.trim();
      if (idType === 'number' && !/^\d+$/.test(lookup)) {
        // Business key (TC-240 / US_123): resolve to the numeric id first.
        if (c.keyField) {
          const found = await this.search({
            op: 'search',
            collection: c.name,
            where: [{ field: c.keyField, op: 'eq', value: id }],
            limit: 1,
          });
          const row = found.rows[0];
          if (row) lookup = String(row[c.idField] ?? row['id'] ?? numericId(id));
          else lookup = numericId(id);
        } else {
          lookup = numericId(id);
        }
      }
      const path = c.getPath.replace('{id}', encodeURIComponent(lookup)).replace('{projectId}', String(this.projectId));
      const row = unwrapOne(await this.http.getJson<unknown>(path));
      // A direct GET by id does not apply the soft-delete filter the searches do.
      if (c.softDelete && row[c.softDelete] === true) fail(`${c.name} ${id} not found`);
      return row;
    }
    // No direct GET: search by id first (string ids such as versions/testdata work), then by key.
    const numeric = idType === 'number' ? Number.parseInt(numericId(id), 10) : undefined;
    const byId = await this.search({
      op: 'search',
      collection: c.name,
      where: [{
        field: c.idField,
        op: 'eq',
        value: numeric !== undefined && Number.isFinite(numeric) ? numeric : id,
      }],
      limit: 1,
    });
    if (byId.rows[0]) return byId.rows[0];
    if (c.keyField) {
      const byKey = await this.search({
        op: 'search',
        collection: c.name,
        where: [{ field: c.keyField, op: 'eq', value: id }],
        limit: 1,
      });
      if (byKey.rows[0]) return byKey.rows[0];
    }
    return fail(`${c.name} ${id} not found`);
  }

  async getWithExpand(req: SqaQueryRequest): Promise<SqaQueryResult> {
    const c = this.requireCollection(req.collection);
    const id = req.id ?? fail('`id` is required for op:"get".');
    const row = await this.get(c.name, id);
    const expanded: Record<string, unknown> = {};
    for (const name of req.expand ?? []) {
      const rel = c.relations?.[name];
      if (!rel) {
        fail(`Unknown expansion "${name}" on ${c.name}. Available: ${c.relations ? Object.keys(c.relations).join(', ') : 'none'}`);
      }
      if (rel.kind === 'subresource') {
        expanded[name] = await this.fetchSubresource(c, rel, id, req.versionId ?? versionIdFromRow(row), row);
      } else {
        const out = await this.related({ ...req, op: 'related', relation: name, id });
        expanded[name] = out.rows;
      }
    }
    return {
      op: 'get',
      collection: c.name,
      row,
      ...(Object.keys(expanded).length ? { expanded } : {}),
    };
  }

  // ----------------------------------------------------------------- compile

  private async compile(
    c: SqaCollection,
    req: SqaQueryRequest,
    offset: number,
    limit: number,
    resolutions: SqaResolution[],
    /** Internal name→id lookups only (never rows shown to the caller): skip the release scope. */
    skipReleaseScope = false,
  ): Promise<Record<string, unknown>> {
    const searchFields: Array<Record<string, unknown>> = [];

    // Hard-coded soft-delete filter. The backend does NOT add it (searchUtil only adds customerId).
    if (c.softDelete) searchFields.push({ column: c.softDelete, value: false });

    // Project scope: always the active project; a caller-supplied project filter is overridden.
    // `scopeProjectIds` (set by the adapter for allProjects, never by the caller) widens the
    // `projectIds` / `release` scopes to the caller's own projects.
    const across = req.scopeProjectIds;
    const all = req.scopeAll === true && (c.scope === 'projectIds' || c.scope === 'release');
    if (c.scope === 'project') searchFields.push({ column: 'projectId', value: this.projectId });
    if (c.scope === 'projectIds' && !all) {
      searchFields.push({ column: 'projectIds', value: across ? (across.length ? across : [-1]) : this.projectId });
    }
    // Release scope (sprints): releaseId ∈ the scoped projects' releases. ANDed with any caller
    // releaseId filter by the backend, so naming another project's release returns nothing.
    if (c.scope === 'release' && !skipReleaseScope && !all) {
      const ids = across ? await this.releaseIdsOf(across) : await this.projectReleaseIds();
      searchFields.push(this.toWire('releaseId', 'in', ids.length ? ids : [-1]));
    }

    // Rows the product hides unless asked (obsolete test cases): `$nor {field:true}` keeps
    // false AND missing, as the UI does. Naming the field in a filter turns this off.
    if (this.resolvesValues && !req.includeHidden) {
      for (const hidden of c.hiddenUnlessAsked ?? []) {
        if (!(req.where ?? []).some((w) => w.field === hidden)) {
          searchFields.push({ column: hidden, value: true, operator: 'nor' });
        }
      }
      const df = c.defaultFilter;
      if (df && !(req.where ?? []).some((w) => df.unless.includes(w.field))) {
        for (const [column, value] of Object.entries(df.where)) searchFields.push({ column, value });
      }
    }

    for (const w of req.where ?? []) {
      if (w.field === 'deleted' || w.field === 'projectId' || w.field === 'projectIds') continue;
      const resolved = await this.resolveWhere(c, w);
      if (this.resolvesValues && resolved.type === 'date') {
        searchFields.push(this.dateWire(resolved.field, resolved.op, w.value, w.condition, resolutions));
        continue;
      }
      // Convenience alias: the UI/adapter historically said type:"TC"; the backend stores TESTCASE.
      let value = coerceValue(resolved.type, w.value);
      if (c.name === 'executions' && resolved.field === 'type' && value === 'TC') value = 'TESTCASE';
      let op = resolved.op;
      const def = c.fields[w.field];
      if (this.resolvesValues && def?.resolve && w.custom !== true) {
        ({ op, value } = await this.translate(c, def, op, value, resolutions));
      }
      searchFields.push(this.toWire(resolved.field, op, value, w.condition));
    }

    const sortFields: Array<Record<string, unknown>> = [];
    for (const s of req.sort ?? []) {
      const field = this.resolveSortField(c, s.field);
      sortFields.push({ column: field, sort: s.dir === 'desc' ? 'dsc' : 'asc' });
    }

    const body: Record<string, unknown> = {
      searchFields: [...searchFields, ...sortFields],
      startIndex: offset,
      limit,
      // The backend treats startIndex as a PAGE unless this is set. Always use row offsets.
      // Joi requires a NUMBER here (1), not a boolean.
      skipStartIndex: 1,
    };

    if (req.select?.length) {
      if (!(req.select.length === 1 && req.select[0] === '*')) {
        body['selectFields'] = req.select;
      }
    } else if (c.defaultSelect.length) {
      body['selectFields'] = c.defaultSelect;
    }
    return body;
  }

  private async resolveWhere(
    c: SqaCollection,
    w: SqaWhere,
  ): Promise<{ field: string; op: SqaOp; type: SqaFieldType }> {
    if (!w.field || !w.field.trim()) fail('Each filter needs a non-empty `field`.');
    const isCustom = w.custom === true || w.field.startsWith('custom:') || w.field.startsWith('customFields.');
    let field: string;
    let allowed: SqaOp[];
    let type: SqaFieldType;

    if (isCustom) {
      if (w.field.startsWith('customFields.')) {
        field = w.field;
        allowed = ['eq', 'ne', 'in', 'not_in', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists'];
        type = 'string';
      } else {
        const name = w.field.startsWith('custom:') ? w.field.slice('custom:'.length) : w.field;
        const cf = await this.resolveCustomField(c.name, name);
        field = cf.column;
        allowed = allowedOpsForControl(cf.controlType);
        type = controlTypeToFieldType(cf.controlType);
      }
    } else {
      const def: SqaField | undefined = c.fields[w.field];
      if (!def) {
        fail(
          `Unknown field "${w.field}" on ${c.name}. ` +
            `Fields: ${Object.keys(c.fields).join(', ')}. ` +
            'For a custom field pass `custom: true` (or `field: "custom:<label>"`).',
        );
      }
      field = def.key;
      allowed = def.ops;
      type = def.type;
    }

    const op = w.op ?? (Array.isArray(w.value) ? 'in' : 'eq');
    if (!allowed.includes(op)) {
      fail(
        `Operator "${op}" is not supported for ${c.name}.${w.field}. Supported: ${allowed.join(', ')}.`,
      );
    }
    return { field, op, type };
  }

  /**
   * Translate filter words to stored values for a field with `resolve` set. Only eq/ne/in/not_in
   * are translated (`contains` stays a literal match). Values already stored exactly as given are
   * returned untouched — so an existing query's payload never changes — and when the options
   * cannot be read the filter is sent as given (today's behaviour), never dropped. A word that
   * matches nothing is an error naming the valid values, never a silent empty result.
   */
  private async translate(
    c: SqaCollection,
    def: SqaField,
    op: SqaOp,
    value: SqaWhere['value'],
    resolutions: SqaResolution[],
  ): Promise<{ op: SqaOp; value: SqaWhere['value'] }> {
    if (value === undefined || !['eq', 'ne', 'in', 'not_in'].includes(op)) return { op, value };
    const words = (Array.isArray(value) ? value : [value]).map((v) => String(v));
    const out: Array<string | number> = [];
    const unknown: string[] = [];

    if (def.resolve === 'ref') {
      // Ids stay ids: only words that are not numbers are looked up.
      const isId = (w: string) => /^\d+$/.test(w.trim());
      if (words.every(isId)) return { op, value };
      for (const w of words) {
        if (isId(w)) { out.push(Number(w)); continue; }
        const ids = await this.resolveRef(def.refTo!, w);
        if (ids.length) out.push(...ids);
        else unknown.push(w);
      }
      if (unknown.length) {
        fail(`${c.name}.${def.key}: ${unknown.map((u) => this.noMatchText(def.refTo!, u)).join(' ')}`);
      }
    } else if (def.resolve === 'enum') {
      const values = def.enumValues ?? [];
      if (words.every((w) => values.includes(w))) return { op, value };
      for (const w of words) {
        const hit = matchEnumWord(w, values, def.enumGroups);
        if (hit.length) out.push(...spellings(hit));
        else unknown.push(w);
      }
      if (unknown.length) {
        const groups = Object.entries(def.enumGroups ?? {}).map(([g, vs]) => `${g} (= ${vs.join(' + ')})`);
        fail(
          `${c.name}.${def.key} has no value ${unknown.map((u) => `"${u}"`).join(', ')}. ` +
            `Valid: ${[...values, ...groups].join(', ')}.`,
        );
      }
    } else {
      let options: LifecycleOption[];
      try {
        options = await this.lifecycleOptions(c, def.key);
      } catch {
        return { op, value };
      }
      if (!options.length || words.every((w) => options.some((o) => o.key === w))) return { op, value };
      for (const w of words) {
        const hit = options.some((o) => o.key === w) ? [w] : matchLifecycleWord(w, options, def.key);
        if (hit.length) out.push(...hit);
        else unknown.push(w);
      }
      if (unknown.length) {
        fail(
          `${c.name}.${def.key} has no value ${unknown.map((u) => `"${u}"`).join(', ')} in this project. ` +
            `Valid: ${options.map((o) => (o.label === o.key ? o.key : `${o.label} (${o.key})`)).join(', ')}.`,
        );
      }
    }

    const to = [...new Set(out)];
    resolutions.push({ field: def.key, from: words, to: to.map(String) });
    // Keep the caller's shape: a single eq/ne stays scalar; several values become in/not_in.
    if (op === 'eq' || op === 'ne') {
      if (to.length === 1) return { op, value: to[0]! };
      return { op: op === 'eq' ? 'in' : 'not_in', value: to };
    }
    return { op, value: to };
  }

  /**
   * A date filter as SQA's search reads one: `YYYY-MM-DD` + `offset` (minutes, IST) so the backend
   * builds day boundaries — without `offset` the value is compared as a plain string and range
   * operators are ignored. A window of several days uses the backend's `range` operator.
   */
  private dateWire(
    column: string,
    op: SqaOp,
    value: SqaWhere['value'],
    condition: 'and' | 'or' | undefined,
    resolutions: SqaResolution[],
  ): Record<string, unknown> {
    if (op === 'exists') return this.toWire(column, op, value, condition);
    if (typeof value !== 'string') fail(`${column}: give one date or window as text (e.g. "2026-10-01", "2026-09", "last 7 days").`);
    const w = dateWindow(value);
    if (!w) {
      fail(
        `Cannot read "${value}" as a date for ${column}. Use YYYY-MM-DD, YYYY-MM, "A..B", today, ` +
          'yesterday, this week / month / year, or last N days / weeks / months / years.',
      );
    }
    const oneDay = w.from === w.to;
    resolutions.push({ field: column, from: [value], to: [oneDay ? w.from : `${w.from}..${w.to}`] });
    const out: Record<string, unknown> = { column, offset: IST_OFFSET_MINUTES };
    switch (op) {
      case 'eq':
        if (oneDay) out['value'] = w.from;
        else { out['value'] = { fromDate: w.from, toDate: w.to }; out['operator'] = 'range'; }
        break;
      case 'ne':
        if (!oneDay) fail(`${column}: "not on" works for one day only; use lt / gt for a window.`);
        out['value'] = w.from;
        out['operator'] = 'nor';
        break;
      case 'gt': out['value'] = w.to; out['operator'] = 'gt'; break;     // after the window
      case 'gte': out['value'] = w.from; out['operator'] = 'gte'; break; // from its first day
      case 'lt': out['value'] = w.from; out['operator'] = 'lt'; break;   // before the window
      case 'lte': out['value'] = w.to; out['operator'] = 'lte'; break;   // up to its last day
      default: fail(`Operator "${op}" is not supported on the date field ${column}.`);
    }
    if (condition === 'or') out['condition'] = 'or';
    return out;
  }

  // ------------------------------------------------------------ reference lookups

  private cachedRef<T>(key: string, load: () => Promise<T>): Promise<T> {
    const hit = this.refCache.get(key);
    if (hit && Date.now() - hit.at < REF_TTL_MS) return hit.value as Promise<T>;
    const entry = { at: Date.now(), value: load() };
    this.refCache.set(key, entry);
    entry.value.catch(() => {
      if (this.refCache.get(key) === entry) this.refCache.delete(key);
    });
    return entry.value as Promise<T>;
  }

  /** Rows of a registry collection, read with stored values only (never re-translated). */
  private async rowsOf(
    collection: string, where: SqaWhere[], select: string[], limit = HARD_LIMIT, offset = 0, includeHidden = false,
    skipReleaseScope = false, scopeProjectIds?: number[],
  ): Promise<SqaRow[]> {
    const c = this.requireCollection(collection);
    const req: SqaQueryRequest = {
      op: 'search', collection, where, select, limit,
      ...(includeHidden ? { includeHidden } : {}),
      ...(scopeProjectIds ? { scopeProjectIds } : {}),
    };
    const payload = await this.compile(c, req, offset, Math.min(limit, c.maxLimit ?? HARD_LIMIT), [], skipReleaseScope);
    return asArray(await this.http.postJson<unknown>(c.searchPath, payload));
  }

  /** Every matching row of a registry collection, page by page (the collection's own page size),
   *  up to `cap` rows. */
  private async allRowsOf(
    collection: string, select: string[], cap: number, includeHidden = false, scopeProjectIds?: number[],
  ): Promise<SqaRow[]> {
    const pageSize = Math.min(HARD_LIMIT, this.requireCollection(collection).maxLimit ?? HARD_LIMIT);
    const out: SqaRow[] = [];
    for (let offset = 0; offset < cap; offset += pageSize) {
      const page = await this.rowsOf(collection, [], select, pageSize, offset, includeHidden, false, scopeProjectIds);
      out.push(...page);
      if (page.length < pageSize) break;
    }
    return out;
  }

  /** Every folder of a folder-tree collection in this project (no defaults: sub-folders too),
   *  read once per request — the busiest project measured has 26. */
  private allFolders(c: SqaCollection): Promise<SqaRow[]> {
    return this.allRowsOf(c.name, ['id', 'code', 'name', 'isRoot', 'parentId', 'childIds', 'suiteIds', 'testcaseIds'], MAX_FOLDERS, true);
  }

  /** Ids of the active project's releases (releases are `projectIds`-scoped), read once per TTL. */
  private projectReleaseIds(): Promise<number[]> {
    return this.cachedRef('projectReleaseIds', async () => (await this.allRowsOf('releases', ['id'], MAX_RELEASES))
      .map((r) => r['id'])
      .filter((id): id is number => typeof id === 'number'));
  }

  /** Ids of the releases linked to any of `projectIds` (allProjects), read once per TTL per set. */
  private releaseIdsOf(projectIds: number[]): Promise<number[]> {
    if (!projectIds.length) return Promise.resolve([]);
    const key = `releaseIdsOf:${[...projectIds].sort((a, b) => a - b).join(',')}`;
    return this.cachedRef(key, async () => (await this.allRowsOf('releases', ['id'], MAX_RELEASES, false, projectIds))
      .map((r) => r['id'])
      .filter((id): id is number => typeof id === 'number'));
  }

  /** The customer's user directory (users carry no project) — every page, not just the first. */
  private people(): Promise<Person[]> {
    return this.cachedRef('people', async () => (await this.allRowsOf('users', ['id', 'name', 'username', 'email'], MAX_USERS))
      .filter((r) => typeof r['id'] === 'number')
      .map((r) => ({
        id: r['id'] as number,
        ...(typeof r['name'] === 'string' ? { name: r['name'] } : {}),
        ...(typeof r['username'] === 'string' ? { username: r['username'] } : {}),
        ...(typeof r['email'] === 'string' ? { email: r['email'] } : {}),
      })));
  }

  private named(rows: SqaRow[], labelField = 'name'): NamedRecord[] {
    return rows
      .filter((r) => typeof r['id'] === 'number')
      .map((r) => ({
        id: r['id'] as number,
        ...(typeof r[labelField] === 'string' ? { name: r[labelField] as string } : {}),
        ...(typeof r['code'] === 'string' ? { code: r['code'] as string } : {}),
      }));
  }

  /** This project's releases, and the sprints under them (sprints carry no project field). */
  private projectReleases(): Promise<NamedRecord[]> {
    return this.cachedRef('releases', async () => this.named(await this.rowsOf('releases', [], ['id', 'code', 'name'])));
  }

  private projectSprints(): Promise<NamedRecord[]> {
    return this.cachedRef('sprints', async () => {
      const releaseIds = (await this.projectReleases()).map((r) => r.id);
      if (!releaseIds.length) return [];
      return this.named(await this.rowsOf('sprints', [{ field: 'releaseId', op: 'in', value: releaseIds }], ['id', 'code', 'name']));
    });
  }

  /** Label rows: one per tagging, so one label name is many ids — all of them count. */
  private async tagRows(where: Array<Record<string, unknown>>): Promise<SqaRow[]> {
    return asArray(await this.http.postJson<unknown>('/pm/tags/search', {
      searchFields: [{ column: 'deleted', value: false }, { column: 'projectId', value: this.projectId }, ...where],
      startIndex: 0, limit: HARD_LIMIT, skipStartIndex: 1,
    }));
  }

  /** A word naming a `refTo` record → every id it means. [] = nothing matches. */
  private async resolveRef(refTo: string, word: string): Promise<number[]> {
    const text = word.trim();
    switch (refTo) {
      case 'users': {
        const q = personQuery(text);
        if (SELF_WORDS.has(q)) {
          if (this.options.currentUserId === undefined) {
            fail('Cannot tell who "me" is on this connection — set QA_MCP_USER_ID or use a session token.');
          }
          return [this.options.currentUserId];
        }
        return q ? matchPeople(q, await this.people()) : [];
      }
      case 'tags': {
        const rows = await this.tagRows([{ column: 'name', value: text, regEx: true }]);
        return [...new Set(rows
          .filter((r) => typeof r['id'] === 'number' && String(r['name'] ?? '').trim().toLowerCase() === text.toLowerCase())
          .map((r) => r['id'] as number))];
      }
      case 'releases':
        return matchNamed(text, await this.projectReleases(), true);
      case 'sprints': {
        // A sprint NAME matches across the customer (the boards match by name, and four sprints are
        // called "Sprint 1"); a code or a near-spelling only within this project's releases.
        // Ids only, used to filter rows that are already project-scoped — so the release scope is skipped.
        const byName = this.named(await this.rowsOf(
          'sprints', [{ field: 'name', op: 'contains', value: text }], ['id', 'code', 'name'], HARD_LIMIT, 0, false, true,
        ));
        const exact = matchNamed(text, byName.map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}) })));
        return exact.length ? exact : matchNamed(text, await this.projectSprints(), true);
      }
      default: {
        // modules and linked work items / test cases: code first, else exact name ("Web 2" reads
        // like a code but may be a module's name).
        const target = this.requireCollection(refTo);
        const code = normaliseCode(text);
        if (code && target.keyField) {
          const byCode = await this.rowsOf(refTo, [{ field: target.keyField, op: 'eq', value: code }], ['id', target.keyField, target.labelField]);
          const ids = matchNamed(code, this.named(byCode, target.labelField));
          if (ids.length) return ids;
        }
        const byName = await this.rowsOf(refTo, [{ field: target.labelField, op: 'contains', value: text }], ['id', target.labelField]);
        return matchNamed(text, this.named(byName, target.labelField).map((r) => ({ id: r.id, ...(r.name ? { name: r.name } : {}) })));
      }
    }
  }

  // ------------------------------------------------------------------ display values

  /**
   * Add `_display: { field: "readable value" }` to each row — state/priority/severity labels, user
   * names, module/release/sprint/label names, linked item codes. Raw fields are never changed.
   * Best-effort: a lookup that fails leaves that field without a display value.
   */
  private async decorate(c: SqaCollection, rows: SqaRow[]): Promise<void> {
    if (!rows.length) return;
    if (c.folderTree) {
      // Direct and with-sub-folder counts + path: a parent plan that files everything in
      // sub-folders otherwise reads as empty.
      try {
        const stats = folderStats(await this.allFolders(c));
        for (const row of rows) {
          const s = stats.get(Number(row['id']));
          if (s) row['_folder'] = s;
        }
      } catch { /* counts are best-effort */ }
    }
    const defs = Object.values(c.fields).filter((f) => f.resolve === 'lifecycle' || f.resolve === 'ref');
    const present = defs.filter((f) => rows.some((r) => valuesAt(r, f.key).length));
    const labels = await this.labelMaps(c, present, rows);
    for (const row of rows) {
      const display: Record<string, string> = {};
      for (const f of present) {
        const map = labels.get(f.key);
        const vals = valuesAt(row, f.key);
        if (!map || !vals.length) continue;
        display[f.key] = vals.map((v) => map.get(String(v)) ?? (f.resolve === 'ref' ? `#${v}` : String(v))).join(', ');
      }
      if (Object.keys(display).length) row['_display'] = display;
    }
  }

  /** field key → stored value → readable label, for the lifecycle/ref fields given. One lookup per
   *  reference kind; a failed lookup just leaves that field without labels. */
  private async labelMaps(c: SqaCollection, present: SqaField[], rows: SqaRow[]): Promise<Map<string, Map<string, string>>> {
    const labels = new Map<string, Map<string, string>>(); // field or refTo → raw → label

    const idsByRef = new Map<string, Set<number>>();
    for (const f of present.filter((p) => p.resolve === 'ref')) {
      const set = idsByRef.get(f.refTo!) ?? new Set<number>();
      for (const r of rows) for (const v of valuesAt(r, f.key)) if (/^\d+$/.test(String(v))) set.add(Number(v));
      idsByRef.set(f.refTo!, set);
    }

    await Promise.all([
      ...present.filter((f) => f.resolve === 'lifecycle').map(async (f) => {
        try {
          labels.set(f.key, new Map((await this.lifecycleOptions(c, f.key)).map((o) => [o.key, o.label])));
        } catch { /* no labels for this field */ }
      }),
      ...[...idsByRef].map(async ([refTo, set]) => {
        const ids = [...set].slice(0, HARD_LIMIT);
        if (!ids.length) return;
        try {
          let pairs: Array<[number, string]>;
          if (refTo === 'users') {
            pairs = (await this.people()).map((p) => [p.id, p.name ?? p.username ?? p.email ?? `#${p.id}`]);
          } else if (refTo === 'tags') {
            pairs = (await this.tagRows([{ column: 'id', value: ids }]))
              .map((r) => [Number(r['id']), String(r['name'] ?? '').trim()]);
          } else {
            const t = this.requireCollection(refTo);
            // Linked work items / test cases read best by code; modules, releases, sprints by name.
            const linked = !['modules', 'releases', 'sprints'].includes(refTo);
            pairs = (await this.rowsOf(refTo, [{ field: t.idField, op: 'in', value: ids }], ['id', 'code', t.labelField], ids.length))
              .map((r) => [Number(r['id']), String((linked ? r['code'] : undefined) ?? r[t.labelField] ?? r['code'] ?? '')]);
          }
          labels.set(refTo, new Map(pairs.filter(([, l]) => l).map(([id, l]) => [String(id), l])));
        } catch { /* no names for this reference */ }
      }),
    ]);

    const byField = new Map<string, Map<string, string>>();
    for (const f of present) {
      const map = labels.get(f.resolve === 'ref' ? f.refTo! : f.key);
      if (map) byField.set(f.key, map);
    }
    return byField;
  }

  // ------------------------------------------------------------------------- count

  /** How many rows a request matches — one call, `limit:1`, no display lookups. */
  private async countWhere(c: SqaCollection, req: SqaQueryRequest): Promise<{ total: number; resolved: SqaResolution[] }> {
    const resolved: SqaResolution[] = [];
    const payload = await this.compile(c, { ...req, select: [c.idField] }, 0, 1, resolved);
    const raw = await this.http.postJson<unknown>(c.searchPath, payload);
    return { total: totalOf(raw, asArray(raw)) ?? 0, resolved };
  }

  /**
   * op:"count": the number of rows a search matches, optionally per value of one field.
   *  - plain count → the backend's totalCount (one call);
   *  - groupBy a state/priority/severity/enum field → one count call per configured value, plus
   *    "(unset)" for the remainder;
   *  - any other groupBy, and versioned collections (one entity, several rows) → read the matching
   *    rows (up to COUNT_SCAN_CAP) and count them here; past the cap the result is `approximate`.
   */
  async count(req: SqaQueryRequest): Promise<SqaCountResult> {
    const c = this.requireCollection(req.collection);
    const versioned = this.resolvesValues && c.versioned === true && !req.allVersions;
    let def: SqaField | undefined;
    if (req.groupBy) {
      def = c.fields[req.groupBy];
      if (!def) fail(`Cannot group ${c.name} by "${req.groupBy}". Fields: ${Object.keys(c.fields).join(', ')}.`);
      if (def.type === 'object' || def.type === 'date') fail(`Cannot group by ${c.name}.${def.key} (${def.type}).`);
    }
    const base: SqaQueryRequest = { ...req, op: 'search', offset: 0 };
    if (c.method === 'GET') {
      if (def) fail(`Grouping is not supported on ${c.name}.`);
      const r = await this.search({ ...base, limit: HARD_LIMIT });
      return { collection: c.name, total: r.totalCount ?? r.returned };
    }

    if (!def && !versioned) {
      const r = await this.countWhere(c, base);
      return { collection: c.name, total: r.total, ...(r.resolved.length ? { resolved: r.resolved } : {}) };
    }

    const perValue = def && !versioned && (def.resolve === 'lifecycle' || def.resolve === 'enum');
    if (def && perValue) {
      const values = def.resolve === 'enum'
        ? (def.enumValues ?? []).map((v) => ({ value: v, label: v }))
        : (await this.lifecycleOptions(c, def.key).catch(() => [])).map((o) => ({ value: o.key, label: o.label }));
      if (values.length && values.length <= MAX_VALUE_COUNTS) {
        const first = await this.countWhere(c, base);
        const counts = await mapLimit(values, COUNT_CONCURRENCY, async (v) => {
          const r = await this.countWhere(c, {
            ...base,
            where: [...(req.where ?? []), { field: def!.key, op: 'in', value: def!.resolve === 'enum' ? spellings([v.value]) : [v.value] }],
          });
          return { ...v, count: r.total };
        });
        const groups = counts.filter((g) => g.count > 0);
        const unset = first.total - groups.reduce((n, g) => n + g.count, 0);
        if (unset > 0) groups.push({ value: '', label: '(unset)', count: unset });
        return {
          collection: c.name, total: first.total, groupBy: def.key, groups: sortGroups(groups),
          ...(first.resolved.length ? { resolved: first.resolved } : {}),
        };
      }
    }

    // Read the matching rows and count them here.
    const select = [c.idField, ...(def ? [def.key.split('.')[0]!] : []), ...(versioned ? VERSION_RANK_FIELDS : [])];
    const fetched: SqaRow[] = [];
    let rawTotal = 0;
    const resolved: SqaResolution[] = [];
    for (let offset = 0; offset < COUNT_SCAN_CAP; offset += HARD_LIMIT) {
      const payload = await this.compile(c, { ...base, select }, offset, HARD_LIMIT, offset === 0 ? resolved : []);
      const raw = await this.http.postJson<unknown>(c.searchPath, payload);
      const page = asArray(raw);
      fetched.push(...page);
      rawTotal = totalOf(raw, page) ?? fetched.length;
      if (page.length < HARD_LIMIT || fetched.length >= rawTotal) break;
    }
    const complete = fetched.length >= rawTotal;
    const rows = versioned ? latestById(fetched) : fetched;
    const total = complete ? rows.length : rawTotal;
    const out: SqaCountResult = {
      collection: c.name, total, scanned: fetched.length,
      ...(complete ? {} : { approximate: true }),
      ...(resolved.length ? { resolved } : {}),
    };
    if (!def) return out;

    const counts = new Map<string, number>();
    for (const row of rows) {
      const vals = valuesAt(row, def.key);
      for (const v of vals.length ? vals : ['']) counts.set(String(v), (counts.get(String(v)) ?? 0) + 1);
    }
    const labels = (await this.labelMaps(c, def.resolve ? [def] : [], rows)).get(def.key);
    const groups = [...counts].map(([value, count]) => ({
      value,
      label: value === '' ? '(unset)' : labels?.get(value) ?? (def!.resolve === 'ref' ? `#${value}` : value),
      count,
    }));
    return { ...out, groupBy: def.key, groups: sortGroups(groups) };
  }

  private noMatchText(refTo: string, word: string): string {
    const noun: Record<string, string> = {
      users: 'user', tags: 'label', releases: 'release', sprints: 'sprint', modules: 'module',
      stories: 'user story', epics: 'epic', features: 'feature', defects: 'defect', testcases: 'test case',
    };
    const what = noun[refTo] ?? refTo;
    const hint = refTo === 'users' ? 'Use their name, username or email.' : 'Use its exact name, its code, or its id.';
    return `No ${what} matches "${word}" in this project. ${hint}`;
  }

  private resolveSortField(c: SqaCollection, field: string): string {
    if (field.startsWith('customFields.')) return field;
    const def = c.fields[field];
    if (!def) {
      fail(`Unknown sort field "${field}" on ${c.name}. Fields: ${Object.keys(c.fields).join(', ')}.`);
    }
    if (def.sort === false) fail(`Field "${field}" on ${c.name} is not sortable.`);
    if (def.type === 'array' || def.type === 'object') {
      fail(`Field "${field}" on ${c.name} is not sortable (${def.type}).`);
    }
    return def.key;
  }

  private toWire(
    column: string,
    op: SqaOp,
    value: SqaWhere['value'],
    condition?: 'and' | 'or',
  ): Record<string, unknown> {
    const out: Record<string, unknown> = { column };
    switch (op) {
      case 'eq':
        out['value'] = value;
        break;
      case 'contains':
        out['value'] = value;
        out['regEx'] = true;
        break;
      case 'in':
        out['value'] = Array.isArray(value) ? value : [value];
        break;
      case 'not_in':
        out['value'] = Array.isArray(value) ? value : [value];
        out['operator'] = 'nor';
        break;
      case 'ne':
        out['value'] = value;
        out['operator'] = 'nor';
        break;
      case 'gt':
      case 'gte':
      case 'lt':
      case 'lte':
      case 'exists':
        out['value'] = value;
        out['operator'] = op;
        break;
    }
    if (condition === 'or') out['condition'] = 'or';
    return out;
  }

  // --------------------------------------------------------------- subresource

  private async fetchSubresource(
    c: SqaCollection,
    rel: SqaRelation,
    id: string,
    versionId?: string,
    parentRow?: SqaRow,
  ): Promise<SqaRow[]> {
    const path = rel.subresourcePath ?? fail(`Relation on ${c.name} has no subresourcePath.`);

    if (path.includes('getstepResult')) {
      const row = parentRow ?? (await this.get(c.name, id));
      const executionId = Number(row['id'] ?? id);
      const executionRunId = str(row, 'executionRunId', 'runId', 'uuid');
      const parentId = Number(row['executionItemId'] ?? row['parentId'] ?? 0);
      if (!executionRunId) {
        fail(
          'This execution row has no executionRunId — step results need the run UUID. ' +
            'Use the execution tool (`run_status`) for step-level results.',
        );
      }
      const raw = await this.http.postJson<unknown>('/reports/execution/getstepResult', {
        executionId,
        executionRunId,
        parentId,
        projectId: this.projectId,
      });
      return notDeleted(asArray(raw));
    }

    const params = new URLSearchParams();
    params.set('projectId', String(this.projectId));
    for (const [key, value] of Object.entries(rel.subresourceParams ?? {})) {
      params.set(key, value === 'id' ? id : value);
    }
    let vid = versionId;
    if (!vid && (c.name === 'testcases' || c.name === 'functions')) {
      const row = parentRow ?? (await this.get(c.name, id));
      vid = versionIdFromRow(row);
    }
    if (!vid && c.name === 'functions') {
      vid = await this.newestFunctionVersion(id);
    }
    if (vid && !params.has('versionId')) params.set('versionId', vid);

    const raw = await this.http.getJson<unknown>(`${path}?${params.toString()}`);
    return notDeleted(asArray(raw));
  }

  private async newestFunctionVersion(id: string): Promise<string | undefined> {
    const raw = await this.http.getJson<unknown>(`/tm/function/version/${encodeURIComponent(id)}/${this.projectId}`);
    const rows = asArray(raw);
    if (!rows.length) return undefined;
    const sorted = [...rows].sort(
      (a, b) => Number(b['versionNumber'] ?? 0) - Number(a['versionNumber'] ?? 0),
    );
    return str(sorted[0], 'id', '_id', 'versionId');
  }

  // ---------------------------------------------------------------- GET search

  private async searchGet(
    c: SqaCollection,
    req: SqaQueryRequest,
    offset: number,
    limit: number,
  ): Promise<SqaSearchResult> {
    const path = c.searchPath.replace('{projectId}', String(this.projectId));
    const raw = await this.http.getJson<unknown>(path);
    let rows = asArray(raw);
    // Client-side filters for GET collections (only environments today).
    for (const w of req.where ?? []) {
      if (w.field === 'deleted' || w.field === 'projectId') continue;
      const def = c.fields[w.field] ?? fail(`Unknown field "${w.field}" on ${c.name}.`);
      const op = w.op ?? 'eq';
      rows = rows.filter((r) => matchClient(r[def.key], op, w.value));
    }
    if (c.softDelete) rows = rows.filter((r) => r[c.softDelete!] !== true);
    const totalCount = rows.length;
    const page = rows.slice(offset, offset + limit);
    return {
      collection: c.name,
      rows: page,
      totalCount,
      returned: page.length,
      offset,
      ...(totalCount > offset + page.length ? { nextOffset: offset + page.length } : {}),
    };
  }

  private requireCollection(name: string | undefined): SqaCollection {
    if (!name) fail('`collection` is required. Call sqa_query({op:"catalog"}) to list collections.');
    const c = resolveCollection(name);
    if (!c) {
      fail(
        `Unknown collection "${name}". Available: ${Object.keys(SQA_COLLECTIONS).join(', ')}.`,
      );
    }
    return c;
  }
}

function controlTypeToFieldType(controlType: string | undefined): SqaFieldType {
  switch ((controlType ?? '').toUpperCase()) {
    case 'NUMBER': return 'number';
    case 'DATE': return 'date';
    case 'CHECKBOX':
    case 'LIST':
    case 'RADIO': return 'array';
    case 'USER':
    case 'CLONE':
    case 'RELEASE-SPRINT': return 'number';
    default: return 'string';
  }
}

/** Coerce values by registry/control type so a numeric id passed as "42" still matches a number field. */
function coerceValue(type: SqaFieldType, value: SqaWhere['value']): SqaWhere['value'] {
  if (value === undefined) return value;
  const toNumber = (v: string | number): string | number =>
    typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : v;
  if (type === 'number') {
    if (Array.isArray(value)) return value.map(toNumber);
    return toNumber(value as string | number);
  }
  if (type === 'boolean' && typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  if (type === 'array' && Array.isArray(value)) return value.map(toNumber);
  return value;
}

function allowedOpsForControl(controlType: string | undefined): SqaOp[] {
  switch ((controlType ?? '').toUpperCase()) {
    case 'NUMBER':
      return ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte'];
    case 'DATE':
      return ['eq', 'ne', 'gt', 'gte', 'lt', 'lte'];
    case 'LIST':
    case 'CHECKBOX':
    case 'RADIO':
      return ['in', 'not_in'];
    case 'USER':
    case 'CLONE':
    case 'RELEASE-SPRINT':
      return ['eq', 'in', 'ne'];
    case 'TEXT':
    case 'TEXT-EDITOR':
    default:
      return ['eq', 'contains', 'ne'];
  }
}

function matchClient(value: unknown, op: SqaOp, expected: SqaWhere['value']): boolean {
  if (op === 'eq') return value === expected;
  if (op === 'ne') return value !== expected;
  if (op === 'contains') return String(value ?? '').toLowerCase().includes(String(expected ?? '').toLowerCase());
  if (op === 'in') return Array.isArray(expected) && expected.includes(value as string | number);
  if (op === 'not_in') return Array.isArray(expected) && !expected.includes(value as string | number);
  return false;
}
