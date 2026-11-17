import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ok, err } from '../mcpResult.js';
import type { ProviderAdapter } from '../adapters/types.js';
import type { DefectSummary, SprintSummary, ReleaseSummary, StorySummary } from '../domain/types.js';
import { analyzeOneStory, type Sensitivity, type StoryReport } from './gapAnalysis.tools.js';

/**
 * impact_analysis — blast-radius report from a single anchor (defect | testcase | story | sprint |
 * release). Walks up and down the graph via existing adapter reads. READ-ONLY: emits a verdict
 * (READY / NEEDS_ATTENTION / AT_RISK) and a downstream suggestion block; never mutates state.
 *
 * Verdict rule (kept dumb on purpose — tune when a user says it is wrong):
 *   openCritical > 0 OR uncoveredAcs > 0.3 * totalAcs  → AT_RISK
 *   openMajor    > 0 OR storiesWithNoTests > 0          → NEEDS_ATTENTION
 *   else                                                 → READY
 */
export type ImpactAnalysisToolsDeps = {
  getAdapter: () => ProviderAdapter | null;
};

const NOT_CONNECTED =
  'Not connected to a product. Use qa_connect first — impact_analysis needs a live backend.';

// ponytail: fixed concurrency; raise if a real release has hundreds of sprints/stories.
const CONCURRENCY = 8;
const DEFAULT_SCAN_LIMIT = 500;

type Verdict = 'READY' | 'NEEDS_ATTENTION' | 'AT_RISK';
type AnchorKind = 'defect' | 'testcase' | 'story' | 'sprint' | 'release';

type Metrics = {
  openCriticalDefects: number;
  openMajorDefects: number;
  openDefectsTotal: number;
  uncoveredAcs: number;
  totalAcs: number;
  storiesWithNoTests: number;
  daysToSprintEnd?: number | undefined;
  daysToReleaseEnd?: number | undefined;
};

type ChainNode = { kind: string; id: string; name?: string; plannedEndDate?: string };

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

function verdictFrom(m: Metrics): Verdict {
  if (m.openCriticalDefects > 0) return 'AT_RISK';
  if (m.totalAcs > 0 && m.uncoveredAcs > 0.3 * m.totalAcs) return 'AT_RISK';
  if (m.openMajorDefects > 0 || m.storiesWithNoTests > 0) return 'NEEDS_ATTENTION';
  return 'READY';
}

function daysUntil(dateStr: string | undefined): number | undefined {
  if (!dateStr) return undefined;
  const t = Date.parse(dateStr);
  if (Number.isNaN(t)) return undefined;
  return Math.round((t - Date.now()) / (24 * 60 * 60 * 1000));
}

function isCritical(sev: string | undefined): boolean {
  const s = (sev ?? '').toLowerCase();
  return s === 'critical' || s === 'blocker' || s === 'showstopper';
}
function isMajor(sev: string | undefined): boolean {
  const s = (sev ?? '').toLowerCase();
  return s === 'major' || s === 'high';
}
function isOpen(state: string | undefined): boolean {
  const s = (state ?? '').toLowerCase();
  // Anything not in a terminal bucket counts as open — SQA state vocab varies per project.
  return !(s === 'closed' || s === 'resolved' || s === 'fixed' || s === 'done' || s === 'rejected' || s === 'duplicate');
}

async function findOneDefect(adapter: ProviderAdapter, defectId: string): Promise<DefectSummary | null> {
  // Try `code` filter first (users usually pass DF_77); fall back to numeric `id`.
  const byCode = await adapter.listDefects!({ filters: [{ column: 'code', value: defectId }], limit: 1 });
  if (byCode.length) return byCode[0]!;
  const byId = await adapter.listDefects!({ filters: [{ column: 'id', value: defectId }], limit: 1 });
  return byId[0] ?? null;
}

async function findOneSprint(adapter: ProviderAdapter, sprintId: string): Promise<SprintSummary | null> {
  if (!adapter.listSprints) return null;
  const all = await adapter.listSprints({});
  return all.find((s) => s.id === sprintId) ?? null;
}
async function findOneRelease(adapter: ProviderAdapter, releaseId: string): Promise<ReleaseSummary | null> {
  if (!adapter.listReleases) return null;
  const all = await adapter.listReleases({ scope: 'project' });
  return all.find((r) => r.id === releaseId) ?? null;
}

/** Roll up a set of stories into the metric bundle impact-analysis reports on. */
async function rollupStories(
  adapter: ProviderAdapter,
  stories: StorySummary[],
  sensitivity: Sensitivity,
): Promise<{ metrics: Omit<Metrics, 'daysToSprintEnd' | 'daysToReleaseEnd'>; storyReports: StoryReport[]; defects: DefectSummary[] }> {
  const storyReports = await parallelMap(stories, CONCURRENCY, (s) => analyzeOneStory(adapter, s, sensitivity));
  const defectBatches = await parallelMap(stories, CONCURRENCY, (s) =>
    adapter.listDefects ? adapter.listDefects({ storyId: s.id, limit: 200 }) : Promise.resolve([] as DefectSummary[]),
  );
  const defects = defectBatches.flat();
  const openCritical = defects.filter((d) => isCritical(d.severity) && isOpen(d.state)).length;
  const openMajor = defects.filter((d) => isMajor(d.severity) && isOpen(d.state)).length;
  const openTotal = defects.filter((d) => isOpen(d.state)).length;
  const uncoveredAcs = storyReports.reduce((n, r) => n + r.uncoveredAcs.length, 0);
  const totalAcs = storyReports.reduce((n, r) => n + r.acCount, 0);
  const storiesWithNoTests = storyReports.filter((r) => r.verdict === 'no_tests').length;
  return {
    metrics: {
      openCriticalDefects: openCritical,
      openMajorDefects: openMajor,
      openDefectsTotal: openTotal,
      uncoveredAcs,
      totalAcs,
      storiesWithNoTests,
    },
    storyReports,
    defects,
  };
}

function escCell(v: unknown): string {
  return String(v ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');
}

function renderChain(chain: ChainNode[]): string {
  return chain.map((n) => `${n.kind} ${escCell(n.id)}${n.name ? ` "${escCell(n.name)}"` : ''}`).join(' → ');
}

export function registerImpactAnalysisTools(server: McpServer, deps: ImpactAnalysisToolsDeps): void {
  server.registerTool(
    'impact_analysis',
    {
      title: 'Blast-radius report from a single anchor (defect / testcase / story / sprint / release)',
      description:
        'BLAST-RADIUS report from ONE anchor — walks the graph both ways to answer "if this is broken / ' +
        'unfinished, what does it affect?" READ-ONLY.\n\n' +
        'PICK EXACTLY ONE ANCHOR:\n' +
        '  • `defectId`   (DF_77) — walks defect → TC(s) → story → sprint → release, then sibling stories in the sprint.\n' +
        '  • `testCaseId` (TC_204) — walks TC → open defects on it → story → sprint → release.\n' +
        '  • `storyId`    (US_103) — walks story → its TCs / defects / sprint / release / sibling stories.\n' +
        '  • `sprintId`   — rolls up every story in the sprint: uncovered ACs, open critical / major defects, stories with no tests.\n' +
        '  • `releaseId`  — per-sprint table with a rolled-up release verdict.\n\n' +
        'VERDICT (traffic light, deliberately simple):\n' +
        '  · `AT_RISK`         — any open critical defect, OR more than 30% of ACs uncovered.\n' +
        '  · `NEEDS_ATTENTION` — any open major defect, OR a story in scope has zero tests.\n' +
        '  · `READY`           — otherwise.\n\n' +
        'Reuses `gap_analysis`\'s per-story analyser to count uncovered ACs, so the AC↔step match rules ' +
        '(Jaccard, sensitivity) are consistent between the two tools. Writes nothing — any triage the ' +
        'user chooses (reassign, descope, add TC) goes through the existing write tools after they confirm.',
      inputSchema: {
        defectId: z.string().optional().describe('Defect id or code (DF_77).'),
        testCaseId: z.string().optional().describe('Test case id or code (TC_204).'),
        storyId: z.string().optional().describe('Story id or business key (US_103).'),
        sprintId: z.string().optional().describe('Sprint id (from list_sprints).'),
        releaseId: z.string().optional().describe('Release id (from list_releases).'),
        sensitivity: z.enum(['strict', 'normal', 'loose']).optional().describe(
          'AC↔step match strictness passed through to gap analysis. Default `normal`.',
        ),
        scanLimit: z.number().int().positive().optional().describe(
          'Cap on the initial listStories fetch for sprint/release rollups. Default 500.',
        ),
      },
      annotations: { readOnlyHint: true },
    },
    async (input) => {
      const adapter = deps.getAdapter();
      if (!adapter) return err(NOT_CONNECTED);
      if (!adapter.listStories || !adapter.getStory) {
        return err('This product does not expose a user-story backlog — impact_analysis needs listStories + getStory.');
      }

      const anchors = [
        input.defectId ? 'defectId' : null,
        input.testCaseId ? 'testCaseId' : null,
        input.storyId ? 'storyId' : null,
        input.sprintId ? 'sprintId' : null,
        input.releaseId ? 'releaseId' : null,
      ].filter(Boolean) as string[];
      if (anchors.length === 0) {
        return err(
          'Pick an anchor: pass exactly one of `defectId`, `testCaseId`, `storyId`, `sprintId`, ' +
          '`releaseId`. ASK the user which fits — do not guess.',
        );
      }
      if (anchors.length > 1) {
        return err(`Pick exactly one anchor — got ${anchors.length}: ${anchors.join(', ')}.`);
      }

      const sensitivity: Sensitivity = input.sensitivity ?? 'normal';
      const scanLimit = input.scanLimit ?? DEFAULT_SCAN_LIMIT;

      try {
        // -------- defect / testcase / story anchors: navigate up to sprint/release, then roll up that sprint.
        if (input.defectId || input.testCaseId || input.storyId) {
          let defect: DefectSummary | null = null;
          let tcIds: string[] = [];
          let storyIds: string[] = [];

          if (input.defectId) {
            defect = await findOneDefect(adapter, input.defectId);
            if (!defect) return err(`No defect found matching \`${input.defectId}\`.`);
            tcIds = defect.tcIds ?? [];
          } else if (input.testCaseId) {
            tcIds = [input.testCaseId];
          } else if (input.storyId) {
            storyIds = [input.storyId];
          }

          // Resolve TC → story links.
          if (tcIds.length > 0 && storyIds.length === 0) {
            const tcs = await parallelMap(tcIds, CONCURRENCY, (id) => adapter.getTestCase(id));
            storyIds = Array.from(new Set(tcs.map((t) => t.storyRef).filter((s): s is string => !!s)));
            if (storyIds.length === 0) {
              return ok(
                `${defect ? `Defect ${defect.code ?? defect.id} "${defect.title}"` : `Test case ${input.testCaseId}`} — ` +
                  `linked TCs have no story reference; walk stops at the TC. No sprint/release impact to report.`,
                { anchor: input, verdict: 'NEEDS_ATTENTION' satisfies Verdict, chain: [], metrics: {} },
              );
            }
          }

          // Story → sprint / release via the (freshly widened) Story fields.
          const stories = await parallelMap(storyIds, CONCURRENCY, (id) => adapter.getStory!(id));
          const sprintIds = Array.from(new Set(stories.map((s) => s.sprintId).filter((x): x is string => !!x)));
          const releaseIds = Array.from(new Set(stories.map((s) => s.releaseId).filter((x): x is string => !!x)));
          const featureIds = Array.from(new Set(stories.map((s) => s.featureId).filter((x): x is string => !!x)));

          // Resolve first sprint / release for the chain header (a story usually belongs to one).
          const sprint = sprintIds[0] ? await findOneSprint(adapter, sprintIds[0]) : null;
          const release = releaseIds[0] ? await findOneRelease(adapter, releaseIds[0]) : sprint?.releaseId ? await findOneRelease(adapter, sprint.releaseId) : null;

          // Sibling stories in the same sprint (sprint-wide rollup below uses this too).
          let sprintStories: StorySummary[] = [];
          if (sprintIds[0]) sprintStories = await adapter.listStories!({ sprintId: sprintIds[0], limit: scanLimit });
          // ponytail: `dependentStories` (siblings sharing a featureId) would need a per-sibling
          // getStory to check featureId — skipped until a real user says the sprint-wide rollup
          // isn't enough signal for the dependency question.
          void featureIds;

          // Roll up the SPRINT (not just the anchor's own story) so the verdict reflects the wider impact.
          const rollupTarget = sprintStories.length > 0
            ? sprintStories
            : stories.map((s): StorySummary => ({ id: s.id, ...(s.key ? { key: s.key } : {}), title: s.title }));
          const { metrics: base, storyReports, defects } = await rollupStories(adapter, rollupTarget, sensitivity);
          const metrics: Metrics = {
            ...base,
            ...(sprint?.plannedEndDate ? { daysToSprintEnd: daysUntil(sprint.plannedEndDate) } : {}),
            ...(release?.plannedEndDate ? { daysToReleaseEnd: daysUntil(release.plannedEndDate) } : {}),
          };
          const verdict = verdictFrom(metrics);

          // Build the chain view (defect → tc → story → sprint → release).
          const chain: ChainNode[] = [];
          if (defect) chain.push({ kind: 'defect', id: defect.code ?? defect.id, ...(defect.title ? { name: defect.title } : {}) });
          for (const tcId of tcIds.slice(0, 3)) chain.push({ kind: 'testcase', id: tcId });
          if (tcIds.length > 3) chain.push({ kind: 'testcase', id: `+${tcIds.length - 3} more` });
          for (const s of stories.slice(0, 3)) chain.push({ kind: 'story', id: s.key ?? s.id, name: s.title });
          if (stories.length > 3) chain.push({ kind: 'story', id: `+${stories.length - 3} more` });
          if (sprint) chain.push({ kind: 'sprint', id: sprint.id, name: sprint.name, ...(sprint.plannedEndDate ? { plannedEndDate: sprint.plannedEndDate } : {}) });
          if (release) chain.push({ kind: 'release', id: release.id, name: release.name, ...(release.plannedEndDate ? { plannedEndDate: release.plannedEndDate } : {}) });

          const anchorLine = defect
            ? `**${defect.code ?? defect.id}** "${defect.title}" · ${defect.severity ?? '?'} · ${defect.state ?? '?'}`
            : input.testCaseId
              ? `**Test case ${input.testCaseId}**`
              : `**Story ${input.storyId}**`;
          const sprintBlock = sprint
            ? `\n\nSprint **${sprint.name}** (${sprint.id}): ${verdict}\n` +
              `  · ${metrics.openCriticalDefects} critical, ${metrics.openMajorDefects} major open defects across ${rollupTarget.length} stor${rollupTarget.length === 1 ? 'y' : 'ies'}\n` +
              `  · ${metrics.uncoveredAcs}/${metrics.totalAcs} ACs uncovered · ${metrics.storiesWithNoTests} stor${metrics.storiesWithNoTests === 1 ? 'y' : 'ies'} without tests` +
              (metrics.daysToSprintEnd !== undefined ? `\n  · Sprint ends ${sprint.plannedEndDate ?? '—'} (${metrics.daysToSprintEnd} day${Math.abs(metrics.daysToSprintEnd) === 1 ? '' : 's'})` : '')
            : '';
          const releaseBlock = release
            ? `\n\nRelease **${release.name}** (${release.id})` +
              (metrics.daysToReleaseEnd !== undefined ? ` — planned ${release.plannedEndDate ?? '—'} (${metrics.daysToReleaseEnd} day${Math.abs(metrics.daysToReleaseEnd) === 1 ? '' : 's'})` : '')
            : '';

          const text =
            `${anchorLine}\n\n` +
            `Blast radius:\n  ${renderChain(chain)}${sprintBlock}${releaseBlock}\n\n` +
            `**Verdict: ${verdict}**`;

          return ok(text, {
            anchor: { kind: (input.defectId ? 'defect' : input.testCaseId ? 'testcase' : 'story') as AnchorKind, id: input.defectId ?? input.testCaseId ?? input.storyId ?? '' },
            verdict,
            chain,
            metrics,
            siblings: {
              storiesInSprint: sprintStories.map((s) => s.id),
            },
            storyReports,
            defects,
          });
        }

        // -------- sprint anchor
        if (input.sprintId) {
          const sprint = await findOneSprint(adapter, input.sprintId);
          const stories = await adapter.listStories!({ sprintId: input.sprintId, limit: scanLimit });
          if (stories.length === 0) {
            return ok(`Sprint ${input.sprintId} — no stories in scope. Verdict: READY.`, {
              anchor: { kind: 'sprint' as AnchorKind, id: input.sprintId },
              verdict: 'READY' satisfies Verdict,
              chain: [],
              metrics: {},
            });
          }
          const { metrics: base, storyReports, defects } = await rollupStories(adapter, stories, sensitivity);
          const release = sprint?.releaseId ? await findOneRelease(adapter, sprint.releaseId) : null;
          const metrics: Metrics = {
            ...base,
            ...(sprint?.plannedEndDate ? { daysToSprintEnd: daysUntil(sprint.plannedEndDate) } : {}),
            ...(release?.plannedEndDate ? { daysToReleaseEnd: daysUntil(release.plannedEndDate) } : {}),
          };
          const verdict = verdictFrom(metrics);
          const topBlockers = defects.filter((d) => isCritical(d.severity) && isOpen(d.state)).slice(0, 5)
            .map((d) => `  · ${d.code ?? d.id} (critical) — "${d.title}"`);
          const missingTests = storyReports.filter((s) => s.verdict === 'no_tests').slice(0, 5)
            .map((s) => `  · ${s.key ?? s.id} has zero linked TCs`);
          const text =
            `**Sprint ${sprint?.name ?? input.sprintId}** · ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} · READINESS: ${verdict}\n\n` +
            `Uncovered ACs: ${metrics.uncoveredAcs}/${metrics.totalAcs} · Open critical: ${metrics.openCriticalDefects} · Open major: ${metrics.openMajorDefects} · Stories w/o tests: ${metrics.storiesWithNoTests}` +
            (metrics.daysToSprintEnd !== undefined ? `\nSprint ends ${sprint?.plannedEndDate ?? '—'} (${metrics.daysToSprintEnd} day${Math.abs(metrics.daysToSprintEnd) === 1 ? '' : 's'})` : '') +
            (topBlockers.length || missingTests.length ? '\n\nTop blockers:\n' + [...topBlockers, ...missingTests].join('\n') : '');
          return ok(text, {
            anchor: { kind: 'sprint' as AnchorKind, id: input.sprintId, ...(sprint?.name ? { name: sprint.name } : {}) },
            verdict,
            chain: sprint && release ? [{ kind: 'sprint', id: sprint.id, name: sprint.name }, { kind: 'release', id: release.id, name: release.name }] : [],
            metrics,
            storyReports,
            defects,
          });
        }

        // -------- release anchor
        if (input.releaseId) {
          const release = await findOneRelease(adapter, input.releaseId);
          if (!adapter.listSprints) return err('This product has no sprint model — cannot roll up a release.');
          const sprints = await adapter.listSprints({ releaseId: input.releaseId });
          if (sprints.length === 0) {
            return ok(`Release ${release?.name ?? input.releaseId} — no sprints in scope. Verdict: READY.`, {
              anchor: { kind: 'release' as AnchorKind, id: input.releaseId },
              verdict: 'READY' satisfies Verdict,
              chain: [],
              metrics: {},
              perSprint: [],
            });
          }

          const perSprint = await parallelMap(sprints, Math.min(CONCURRENCY, 4), async (sp) => {
            const spStories = await adapter.listStories!({ sprintId: sp.id, limit: scanLimit });
            const { metrics: spMetrics } = await rollupStories(adapter, spStories, sensitivity);
            const v = verdictFrom({ ...spMetrics });
            return {
              sprintId: sp.id,
              name: sp.name,
              storyCount: spStories.length,
              uncoveredAcs: spMetrics.uncoveredAcs,
              openCritical: spMetrics.openCriticalDefects,
              openMajor: spMetrics.openMajorDefects,
              storiesWithNoTests: spMetrics.storiesWithNoTests,
              verdict: v,
              plannedEndDate: sp.plannedEndDate,
            };
          });

          const aggregate: Metrics = {
            openCriticalDefects: perSprint.reduce((n, p) => n + p.openCritical, 0),
            openMajorDefects: perSprint.reduce((n, p) => n + p.openMajor, 0),
            openDefectsTotal: 0,
            uncoveredAcs: perSprint.reduce((n, p) => n + p.uncoveredAcs, 0),
            totalAcs: 0,
            storiesWithNoTests: perSprint.reduce((n, p) => n + p.storiesWithNoTests, 0),
            ...(release?.plannedEndDate ? { daysToReleaseEnd: daysUntil(release.plannedEndDate) } : {}),
          };
          const verdict = verdictFrom(aggregate);

          const table =
            '| sprint | stories | uncovered ACs | open critical | open major | no-tests | verdict |\n|---|---|---|---|---|---|---|\n' +
            perSprint
              .map(
                (p) =>
                  `| ${escCell(p.name ?? p.sprintId)} | ${p.storyCount} | ${p.uncoveredAcs} | ${p.openCritical} | ${p.openMajor} | ${p.storiesWithNoTests} | ${p.verdict} |`,
              )
              .join('\n');
          const text =
            `**Release ${release?.name ?? input.releaseId}** · ${sprints.length} sprint${sprints.length === 1 ? '' : 's'} · READINESS: ${verdict}\n\n` +
            (aggregate.daysToReleaseEnd !== undefined ? `Planned end ${release?.plannedEndDate ?? '—'} (${aggregate.daysToReleaseEnd} day${Math.abs(aggregate.daysToReleaseEnd) === 1 ? '' : 's'})\n\n` : '') +
            table;

          return ok(text, {
            anchor: { kind: 'release' as AnchorKind, id: input.releaseId, ...(release?.name ? { name: release.name } : {}) },
            verdict,
            chain: release ? [{ kind: 'release', id: release.id, name: release.name }] : [],
            metrics: aggregate,
            perSprint,
          });
        }

        return err('Unreachable: no anchor branch matched.');
      } catch (e) {
        return err(e instanceof Error ? e.message : String(e));
      }
    },
  );
}
