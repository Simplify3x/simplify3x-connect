/**
 * The `stack_setup` inputs and reply shared by `execution_plan` and `suite_manage`: per-stack platform (local / remote / cloud),
 * browser, machine and test cases, plus `append` — so "configure the 1st stack as local, the 2nd as cloud and the 3rd as remote,
 * and put TC-39 on the first" is one call.
 */

import { z } from 'zod';
import type { StackSetupResult } from '../adapters/simplifyqa/adapter.js';

export const stackConfigsSchema = z.array(z.object({
  mode: z.enum(['local', 'remote', 'cloud']).optional().describe('Where THIS stack runs (default: stackMode, else cloud).'),
  browser: z.string().optional().describe('Browser for the WEB test cases on this stack. LOCAL / REMOTE stacks: chrome, firefox, edge, safari (and their headless / incognito variants). A CLOUD stack offers ONLY Chrome Headless, Firefox Headless or Edge Headless — pass chrome / firefox / edge and it is that headless one; any other value is refused with those three. Default chrome (its headless one on a cloud stack).'),
  agentId: z.string().optional().describe('REMOTE stacks only, required: the machine to run on — its id or machine name (see local_agents / remote_agents).'),
  testCases: z.array(z.string()).optional().describe('Test cases (TC-39 or id) to put on THIS stack. Name them for every stack, or for none (then they are spread evenly).'),
})).optional().describe(
  'stack_setup: describe each stack, in order — one entry per stack (this sets the number of stacks; leave `stacks` out or make it match). ' +
    'E.g. [{ mode:"local" }, { mode:"cloud" }, { mode:"remote", agentId:"build-box-2" }].',
);

export const STACK_SETUP_DESC =
  'Saves the Stack Setup (what the Stack canvas saves). Give `stacks` (a number: that many alike, test cases spread round-robin) OR ' +
  '`stackConfigs` (one entry per stack: its platform local / remote / cloud, browser, remote machine and, if the user says which, its test cases). ' +
  '`append:true` ADDS stacks to the saved setup instead of replacing it (existing stacks keep their platform; with no test cases named, all are re-spread ' +
  'over old + new). Every stack needs at least one test case, a REMOTE stack needs a machine, and CLOUD needs a cloud machine configured for the project. ' +
  'Run it afterwards with mode:"stack".';

/** The reply to a stack_setup: what each stack runs on and holds, what was left out, and what to do next. */
export function stackSetupReply(subject: string, res: StackSetupResult, runHint: string): string {
  return (
    `${res.created ? 'Created' : 'Updated'} the Stack setup of ${subject}: ${res.stacks.length} stack(s).\n` +
    res.stacks.map((s) => `- ${s.name} (${s.mode}${s.browser ? `, ${s.browser}` : ''}${s.agentId ? `, machine ${s.agentId}` : ''}): ${s.codes.join(', ') || '(no test cases)'}`).join('\n') +
    (res.unassigned?.length ? `\n⚠️ Not on any stack (they will not run in a Stack run): ${res.unassigned.join(', ')}.` : '') +
    (res.cloudAvailable === false ? '\n⚠️ This project has no cloud machine configured, so CLOUD stacks cannot run yet — add one in the project settings, or make those stacks local / remote.' : '') +
    (res.notes?.length ? `\n${res.notes.map((n) => `ℹ️ ${n}`).join('\n')}` : '') +
    `\n${runHint}`
  );
}
