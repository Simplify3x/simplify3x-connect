/**
 * Plans and reports survive process restarts in `~/.common-qa-mcp/heal/` — no backend collection is
 * required (the backend is out of scope for this change). Keys are the deterministic `planId`.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { HealPlan, HealReport } from '../../../domain/heal.js';

const DIR = path.join(os.homedir(), '.common-qa-mcp', 'heal');
const PLAN_ID = /^[a-f0-9]{8,64}$/;

export type HealStored = { plan: HealPlan; report?: HealReport | undefined };

function fileFor(planId: string, suffix: 'plan' | 'report'): string {
  if (!PLAN_ID.test(planId)) throw new Error(`invalid planId "${planId}"`);
  return path.join(DIR, `${planId}.${suffix}.json`);
}

async function ensureDir(): Promise<void> {
  await mkdir(DIR, { recursive: true });
}

export async function savePlan(plan: HealPlan): Promise<void> {
  await ensureDir();
  await writeFile(fileFor(plan.planId, 'plan'), JSON.stringify(plan, null, 2), 'utf8');
}

export async function loadPlan(planId: string): Promise<HealPlan> {
  const raw = await readFile(fileFor(planId, 'plan'), 'utf8');
  return JSON.parse(raw) as HealPlan;
}

export async function saveReport(report: HealReport): Promise<void> {
  await ensureDir();
  await writeFile(fileFor(report.planId, 'report'), JSON.stringify(report, null, 2), 'utf8');
}

export async function loadStatus(planId: string): Promise<HealStored> {
  const plan = await loadPlan(planId);
  try {
    const report = JSON.parse(await readFile(fileFor(planId, 'report'), 'utf8')) as HealReport;
    return { plan, report };
  } catch {
    return { plan };
  }
}
