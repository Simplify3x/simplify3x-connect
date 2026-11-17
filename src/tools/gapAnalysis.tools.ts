import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { Story, StorySummary, TcSummary } from '../domain/types.js';
import { computeDrift } from './storySync.tools.js';

/**
 * gap_analysis — coverage / gap report over a scope (sprint / release / epic / feature / storyIds /
 * whole project). Read-only aggregator: composes existing adapter reads (listStories / getStory /
 * listTestCases / getTestCase) and delegates the AC↔step matching to `computeDrift` (same helper
 * story_sync_testcases uses). Writes nothing — proposals go back as text hints for the agent to
 * apply via tc_draft_* / story_update.
 */
export type GapAnalysisToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect first — gap_analysis needs a live backend.';

// ponytail: fixed concurrency; raise if a real 500-story sprint feels slow.
const CONCURRENCY = 8;
const DEFAULT_SCAN_LIMIT = 500;

export type Sensitivity = 'strict' | 'normal' | 'loose';
export type Verdict = 'covered' | 'partial' | 'no_tests' | 'no_ac';
type ScopeKind = 'sprint' | 'release' | 'epic' | 'feature' | 'storyIds' | 'project';
type DriftReport = ReturnType<typeof computeDrift>;

export type StoryReport = {
  id: string;
  key?: string;
  title: string;
  acCount: number;
  tcCount: number;
  verdict: Verdict;
  uncoveredAcs: string[];
  driftReports: DriftReport[];
};

type OrphanTc = { id: string; title: string; storyRef: string | null };

type ScopeResult = { kind: ScopeKind; id: string; label: string; stories: StorySummary[]; truncated?: boolean };

async function parallelMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const i = cursor++;
      out[i] = await fn(items[i]!);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return out;
}

function totalOf(rows: unknown[]): number | undefined {
  const t = (rows as { totalCount?: number }).totalCount;
  return typeof t === 'number' ? t : undefined;
}

function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

async function resolveScope(
  adapter: ProviderAdapter,
  input: {
    sprintId?: string | undefined;
    releaseId?: string | undefined;
    epicId?: string | undefined;
    featureId?: string | undefined;
    storyIds?: string[] | undefined;
    projectWide?: boolean | undefined;
  },
  scanLimit: number,
): Promise<ScopeResult> {
  if (input.sprintId) {
    const stories = await adapter.listStories!({ sprintId: input.sprintId, limit: scanLimit });
    return { kind: 'sprint', id: input.sprintId, label: `Sprint ${input.sprintId}`, stories, ...(totalOf(stories) && totalOf(stories)! > stories.length ? { truncated: true } : {}) };
  }
  if (input.releaseId) {
    const stories = await adapter.listStories!({ releaseId: input.releaseId, limit: scanLimit });
    return { kind: 'release', id: input.releaseId, label: `Release ${input.releaseId}`, stories, ...(totalOf(stories) && totalOf(stories)! > stories.length ? { truncated: true } : {}) };
  }
  if (input.epicId) {
    const stories = await adapter.listStories!({
      limit: scanLimit,
      filters: [{ column: 'epicId', value: input.epicId }],
    });
    return { kind: 'epic', id: input.epicId, label: `Epic ${input.epicId}`, stories };
  }
  if (input.featureId) {
    const stories = await adapter.listStories!({
      limit: scanLimit,
      filters: [{ column: 'featureId', value: input.featureId }],
    });
    return { kind: 'feature', id: input.featureId, label: `Feature ${input.featureId}`, stories };
  }
  if (input.storyIds && input.storyIds.length) {
    // Story ids — pull each via getStory (we need ACs downstream anyway) and derive summaries.
    const details = await parallelMap(input.storyIds, CONCURRENCY, (id) => adapter.getStory!(id));
    const stories: StorySummary[] = details.map((s) => ({
      id: s.id,
      ...(s.key ? { key: s.key } : {}),
      title: s.title,
      ...(s.status ? { status: s.status } : {}),
    }));
    return { kind: 'storyIds', id: input.storyIds.join(','), label: `${input.storyIds.length} stor${input.storyIds.length === 1 ? 'y' : 'ies'}`, stories };
  }
  // projectWide
  const stories = await adapter.listStories!({ limit: scanLimit });
  return {
    kind: 'project',
    id: 'projectWide',
    label: 'Whole project',
    stories,
    ...(totalOf(stories) && totalOf(stories)! > stories.length ? { truncated: true } : {}),
  };
}

function classify(acCount: number, tcCount: number, uncoveredCount: number): Verdict {
  if (acCount === 0) return 'no_ac';
  if (tcCount === 0) return 'no_tests';
  if (uncoveredCount > 0) return 'partial';
  return 'covered';
}

export async function analyzeOneStory(
  adapter: ProviderAdapter,
  storyRow: StorySummary,
  sensitivity: Sensitivity,
): Promise<StoryReport> {
  const story: Story = await adapter.getStory!(storyRow.id);
  const acList = (story.acceptanceCriteria ?? []).map((s) => s.trim()).filter(Boolean);

  // TCs linked to this story. Manual + automation both count for coverage headcount; only manual
  // gets a drift report (automation TCs have recorded steps, not AC-derived — computeDrift would
  // false-positive `ac_added` on every AC).
  const tcSummaries: TcSummary[] = await adapter.listTestCases({ storyId: storyRow.id });
  const manualIds = tcSummaries.map((t) => t.id);
  const driftReports: DriftReport[] = [];
  if (acList.length > 0 && manualIds.length > 0) {
    const tcs = await parallelMap(manualIds, CONCURRENCY, (id) => adapter.getTestCase(id));
    for (const tc of tcs) {
      if (tc.category !== 'manual') continue;
      driftReports.push(computeDrift(story, tc, sensitivity));
    }
  }

  // Uncovered = ACs that EVERY manual TC flagged as ac_added (nothing matched them).
  // If no manual TCs ran drift, treat every AC as uncovered.
  let uncoveredAcs: string[];
  if (acList.length === 0) {
    uncoveredAcs = [];
  } else if (driftReports.length === 0) {
    uncoveredAcs = acList.slice();
  } else {
    uncoveredAcs = acList.filter((ac) =>
      driftReports.every((d) => d.signals.some((s) => s.kind === 'ac_added' && s.text === ac)),
    );
  }

  const verdict = classify(acList.length, tcSummaries.length, uncoveredAcs.length);
  return {
    id: story.id,
    ...(story.key ? { key: story.key } : {}),
    title: story.title,
    acCount: acList.length,
    tcCount: tcSummaries.length,
    verdict,
    uncoveredAcs,
    driftReports,
  };
}

async function findOrphanTcs(
  adapter: ProviderAdapter,
  scanLimit: number,
): Promise<OrphanTc[]> {
  // Project-wide TC scan for TCs with an empty storyRef. Only cheap on providers whose listTestCases
  // returns storyRef on summaries — SQA's summaries don't, so we fall back to getTestCase per row.
  // ponytail: bounded by scanLimit; a genuinely huge project would need a dedicated 'orphan-tc' query.
  const summaries = await adapter.listTestCases({ limit: scanLimit });
  const details = await parallelMap(summaries, CONCURRENCY, (s) => adapter.getTestCase(s.id));
  return details
    .filter((tc) => !tc.storyRef || tc.storyRef.trim().length === 0)
    .map((tc) => ({ id: tc.id ?? '', title: tc.title, storyRef: null }));
}

function gapScoreFor(counts: { total: number; covered: number; partial: number }): number {
  if (counts.total === 0) return 100;
  return Math.round((100 * (counts.covered + 0.5 * counts.partial)) / counts.total);
}

function renderText(
  scope: ScopeResult,
  stories: StoryReport[],
  orphans: OrphanTc[],
  score: number,
): string {
  const counts = {
    total: stories.length,
    covered: stories.filter((s) => s.verdict === 'covered').length,
    partial: stories.filter((s) => s.verdict === 'partial').length,
    noTests: stories.filter((s) => s.verdict === 'no_tests').length,
    noAc: stories.filter((s) => s.verdict === 'no_ac').length,
    uncoveredAcs: stories.reduce((n, s) => n + s.uncoveredAcs.length, 0),
    orphanTcs: orphans.length,
  };
  const label = score >= 85 ? 'strong' : score >= 60 ? 'ok' : score >= 30 ? 'needs work' : 'critical';
  const truncNote = scope.truncated ? ` _(scan capped at ${stories.length}; raise \`scanLimit\` for full view)_` : '';
  const header = `**${scope.label}** · ${counts.total} stor${counts.total === 1 ? 'y' : 'ies'} · GAP SCORE ${score}/100 (${label})${truncNote}`;
  const summary =
    `Coverage: ${counts.covered} covered · ${counts.partial} partial · ${counts.noTests} no_tests · ${counts.noAc} no_ac\n` +
    `Signals:  ${counts.uncoveredAcs} uncovered AC${counts.uncoveredAcs === 1 ? '' : 's'}${orphans.length ? ` · ${orphans.length} orphan TC${orphans.length === 1 ? '' : 's'}` : ''}`;
  const table =
    '| story | ACs | TCs | uncovered | verdict |\n|---|---|---|---|---|\n' +
    stories
      .map(
        (s) =>
          `| ${escCell(s.key ?? s.id)} ${escCell(s.title)} | ${s.acCount} | ${s.tcCount} | ${s.verdict === 'no_ac' ? '—' : s.uncoveredAcs.length} | ${s.verdict === 'no_tests' ? 'NO_TESTS' : s.verdict === 'no_ac' ? 'NO_AC' : s.verdict} |`,
      )
      .join('\n');

  const uncoveredList = stories
    .flatMap((s) => s.uncoveredAcs.map((ac) => `  • ${s.key ?? s.id} — ${ac.length > 100 ? ac.slice(0, 97) + '…' : ac}`))
    .slice(0, 10);
  const uncoveredBlock = uncoveredList.length
    ? `\n\nUncovered ACs${uncoveredList.length >= 10 ? ' (top 10)' : ''}:\n${uncoveredList.join('\n')}`
    : '';

  const orphanBlock = orphans.length
    ? `\n\nOrphan TCs (no linked story):\n${orphans.slice(0, 10).map((o) => `  • ${o.id}  "${o.title}"`).join('\n')}${orphans.length > 10 ? `\n  … and ${orphans.length - 10} more` : ''}`
    : '';

  const actions: string[] = [];
  for (const s of stories) {
    if (s.verdict === 'no_tests' && s.acCount > 0) {
      actions.push(`  • tc_draft_create for ${s.key ?? s.id}  (${s.acCount} AC${s.acCount === 1 ? '' : 's'} — no test yet)`);
    } else if (s.verdict === 'partial') {
      for (const d of s.driftReports) {
        if (d.proposedOps.length > 0) {
          actions.push(`  • tc_draft_open ${d.testCaseId} → apply ${d.proposedOps.length} op${d.proposedOps.length === 1 ? '' : 's'} for ${s.key ?? s.id}`);
        }
      }
    } else if (s.verdict === 'no_ac') {
      actions.push(`  • story_update ${s.key ?? s.id} to add acceptanceCriteria`);
    }
  }
  const actionBlock = actions.length
    ? `\n\nNext actions the caller can chain (nothing has been done):\n${actions.slice(0, 15).join('\n')}${actions.length > 15 ? `\n  … and ${actions.length - 15} more` : ''}`
    : '';

  return `${header}\n\n${summary}\n\n${table}${uncoveredBlock}${orphanBlock}${actionBlock}`;
}

export function registerGapAnalysisTools(server: McpServer, deps: GapAnalysisToolsDeps): void {
  server.registerTool(
    'gap_analysis',
    {
      title: 'Coverage / gap report across a scope (sprint, release, epic, feature, stories, project)',
      description:
        'Aggregate COVERAGE report — for a chosen scope, walks each story and reports which have no ' +
        'tests, which have ACs not covered by any linked test case, which have no acceptance criteria ' +
        'at all, and (for release / projectWide scopes) which TCs are unlinked to any story. ' +
        'READ-ONLY: writes nothing, but emits a "Next actions" hint block for the agent to chain into ' +
        'tc_draft_create / tc_draft_open+update+save / story_update after asking the user.\n\n' +
        'PICK EXACTLY ONE SCOPE — the tool errors if zero or more than one is provided:\n' +
        '  • `sprintId`    — recommended for sprint reviews\n' +
        '  • `releaseId`   — release readiness across all sprints in the release\n' +
        '  • `epicId`      — coverage on one epic\n' +
        '  • `featureId`   — coverage on one feature\n' +
        '  • `storyIds[]`  — hand-picked batch (or a single story: the same info story_sync_testcases returns, wrapped in the gap format)\n' +
        '  • `projectWide: true` — every story (expensive; prefer a narrower scope when the user\'s ' +
        'question is really about a sprint / release / area)\n\n' +
        'Reuses the same AC↔step matching as `story_sync_testcases` (Jaccard, sensitivity strict / ' +
        'normal / loose). Automation test cases COUNT toward `tcCount` but do NOT run drift ' +
        '(their steps are recorded, not AC-derived — computeDrift would false-flag every AC as ' +
        'uncovered). Orphan-TC detection runs only for `releaseId` / `projectWide` scopes.\n\n' +
        'When the user\'s question is about a single story, prefer `story_sync_testcases` if they ' +
        'want the drift ops to apply; use this tool if they want a coverage verdict / report.',
      inputSchema: {
        sprintId: z.string().optional().describe('Sprint id (from list_sprints).'),
        releaseId: z.string().optional().describe('Release id (from list_releases).'),
        epicId: z.string().optional().describe('Epic numeric id or business key (EP_123).'),
        featureId: z.string().optional().describe('Feature numeric id or business key (FT_123).'),
        storyIds: z.array(z.string()).optional().describe('One or more story ids/keys (US_123).'),
        projectWide: z.boolean().optional().describe(
          'Set true to scan every story in the project (bounded by scanLimit). Prefer a narrower ' +
          'scope when possible — projectWide fans out into many adapter calls.',
        ),
        sensitivity: z.enum(['strict', 'normal', 'loose']).optional().describe(
          'AC↔step match strictness (same as story_sync_testcases). Default `normal`.',
        ),
        scanLimit: z.number().int().positive().optional().describe(
          'Cap on the initial listStories fetch (and, for release/projectWide, the orphan-TC scan). ' +
          'Default 500. Raise for a genuinely huge project.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listStories || !adapter.getStory) {
        return err('This product does not expose a user-story backlog — gap_analysis needs listStories + getStory.');
      }

      // Exactly-one-scope guard. `storyIds: []` counts as absent.
      const scopeKeys = [
        input.sprintId ? 'sprintId' : null,
        input.releaseId ? 'releaseId' : null,
        input.epicId ? 'epicId' : null,
        input.featureId ? 'featureId' : null,
        input.storyIds && input.storyIds.length > 0 ? 'storyIds' : null,
        input.projectWide === true ? 'projectWide' : null,
      ].filter(Boolean) as string[];
      if (scopeKeys.length === 0) {
        return err(
          'Pick a scope: pass exactly one of `sprintId`, `releaseId`, `epicId`, `featureId`, ' +
          '`storyIds`, or `projectWide: true`. ASK the user which scope fits their question — do not guess.',
        );
      }
      if (scopeKeys.length > 1) {
        return err(`Pick exactly one scope — got ${scopeKeys.length}: ${scopeKeys.join(', ')}.`);
      }

      const sensitivity: Sensitivity = input.sensitivity ?? 'normal';
      const scanLimit = input.scanLimit ?? DEFAULT_SCAN_LIMIT;

      try {
        const scope = await resolveScope(adapter, input, scanLimit);
        if (scope.stories.length === 0) {
          return ok(`**${scope.label}** — no stories in scope.`, {
            scope: { kind: scope.kind, id: scope.id, label: scope.label },
            gapScore: 100,
            counts: { total: 0, covered: 0, partial: 0, noTests: 0, noAc: 0, uncoveredAcs: 0, orphanTcs: 0 },
            stories: [],
            orphanTcs: [],
          });
        }

        const stories = await parallelMap(scope.stories, CONCURRENCY, (s) =>
          analyzeOneStory(adapter, s, sensitivity),
        );

        // Orphan TC scan only for release / projectWide — cheaper scopes don't justify a full-project TC read.
        let orphans: OrphanTc[] = [];
        if (scope.kind === 'release' || scope.kind === 'project') {
          orphans = await findOrphanTcs(adapter, scanLimit);
        }

        const counts = {
          total: stories.length,
          covered: stories.filter((s) => s.verdict === 'covered').length,
          partial: stories.filter((s) => s.verdict === 'partial').length,
          noTests: stories.filter((s) => s.verdict === 'no_tests').length,
          noAc: stories.filter((s) => s.verdict === 'no_ac').length,
          uncoveredAcs: stories.reduce((n, s) => n + s.uncoveredAcs.length, 0),
          orphanTcs: orphans.length,
        };
        const gapScore = gapScoreFor(counts);
        const text = renderText(scope, stories, orphans, gapScore);
        return ok(text, {
          scope: { kind: scope.kind, id: scope.id, label: scope.label, ...(scope.truncated ? { truncated: true } : {}) },
          gapScore,
          counts,
          stories,
          orphanTcs: orphans,
        });
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
