/**
 * Unified action-signature registry (WEB) — shadow registry.
 *
 * ONE declaration per action = the single source of truth for its step-description shape
 * and what it requires (object binding, parameters). Today these facts are re-declared
 * independently across ~5 consumers (action def, LLM schema, bake, parameterizer, execute
 * validation) and drift out of sync — the root cause of the verify_value / store /
 * verify-description bugs. Later phases make each consumer DERIVE from this registry.
 *
 * The registry declares the FULL web action catalog — every catalogued web action_type: the
 * playwright action handlers PLUS the three step-handler web actions (store_run_variable,
 * store_global_variable, switch_window, declared at the bottom, shadow-only). Two
 * web-registered action_types are intentionally EXCLUDED: `tap` (a mobile/touch action kept
 * out of the web catalog) and `verify_element_state` (a backward-compatible ALIAS of
 * `verify_element_visible` — same handler + template; declaring both would be a pure
 * duplicate, so only verify_element_visible is here). Both stay registered/executable elsewhere. The registry stays
 * SHADOW-ONLY at runtime: deriveWebStepSemantics only DERIVES its description from this
 * registry for the verify family (the sole reader, stepSemantics.ts). Every other entry is
 * proven faithful to the live bake by the golden-oracle test (actionSignatures.test.ts) for
 * the actions the recorder emits, and structurally validated for execution-only actions the
 * recorder never produces (snapshot, tracing, dialogs, …).
 *
 * Leaf module by design (no generateTestSteps import chain, and no stepSemantics import —
 * stepSemantics imports THIS file, so importing back would be circular), so tests can import
 * the REAL code — the same reason journalPlacement.ts / androidJournalFirst.ts are separate.
 *
 * Design: docs/superpowers/specs/2026-07-19-unified-action-signature-registry-design.md
 */

export interface ActionParam {
  /** Test-data column minted for this action's value (e.g. 'expected_value'). When
   *  `derivedFromObject` is set this is the FALLBACK name used when the element has no
   *  usable label. */
  name: string;
  /** Which template slot the value fills: a content value, or an element state. */
  slot: 'value' | 'state';
  /** When true, the param NAME is derived from the captured element label at bake time
   *  (snake_case), falling back to `name`. Models type/select, whose param is named after
   *  the field — e.g. "Email Field" → `Enter ${email_field} in Email Field`. The template
   *  carries this param as its fallback `${name}` token (e.g. `${value}`); fillDescription
   *  rewrites that token to the object-derived name when an element is present. */
  derivedFromObject?: boolean;
  /** The VALUE KIND replay can actually use. Declared only where the WRONG kind misexecutes
   *  SILENTLY: every `number` param is read with a digit regex at replay and falls back to a
   *  default when it doesn't match (resize → 1280x720, wait_timeout → 1000ms, tabs → last tab,
   *  mouse_* → 0,0), so a non-numeric literal runs a DIFFERENT action instead of failing.
   *  Undeclared = free text, nothing to check. Surfaced to the step editor via the authoring
   *  contract (actionSyncService.authoringContract). */
  valueType?: 'number';
  /** Declared for completeness, but the author does NOT have to supply it — it is absent from
   *  the catalog template and only applies to some operators (verify_compare's `tolerance` is
   *  read for `close_to` only). Kept out of the authoring contract's required list. */
  optional?: true;
}

// NOTE — no closed word list for the `state` slot on purpose. verify-element-visible's handler
// DEFAULTS to `visible` for any word it doesn't recognise, and 345 of 113,113 existing steps say
// "is displayed" / "is shown" — wording that reads correctly and replays correctly. Rejecting
// those words at authoring time would be a false block, so state stays free text.

export interface ActionSignature {
  /** Matches action_type, e.g. 'verify_value'. */
  actionType: string;
  /**
   * The exact step-description shape. `<element>` is the ONLY angle-bracket token — a human
   * ELEMENT placeholder (present iff `requires.object`): the Manual Steps editor shows it raw
   * (not a purple parameter), while recording fills it with the captured element name. Values
   * are always `${...}` PARAM tokens — never angle-bracketed. Substitution at bake time:
   *   `<element>`     → the captured element label.
   *   `${inputValue}` → the captured literal value (verify text/value only).
   *   `${<name>}` of a `derivedFromObject` param → rewritten to the object-derived name
   *                     (e.g. `${value}` → `${email_field}`) when an element is present.
   * Every other `${...}` is a fixed PARAM token that survives verbatim (`${expected_state}`,
   * `${file_path}`, `${key_name}`, `${target}`, `${url}`, …) — declared in `requires.params`.
   *
   * Templates model the PRIMARY (object/value-present) form only; the degenerate no-object
   * / no-value cases stay hand-coded in deriveWebStepSemantics.
   */
  descriptionTemplate: string;
  requires: {
    /** Needs an element/selector binding — rejected at record time if missing. Mirrors the
     *  action handler's `needsLocator` for interaction actions; a few verify actions carry a
     *  recorded object even though their replay handler resolves it without a pinned locator. */
    object: boolean;
    params?: ActionParam[];
  };
}

/** snake_case a captured element label into a parameter name — e.g. "Email Field" →
 *  "email_field". MIRROR of stepSemantics.paramNameFromObject; kept LOCAL because
 *  stepSemantics.ts imports THIS module (importing back would be circular). The golden-oracle
 *  test compares fillDescription against the live bake, so any drift between the two copies
 *  fails the test. */
function deriveParamName(objectName?: string): string {
  return objectName ? objectName.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '') : '';
}

/**
 * Fill a signature's template with a captured element name + value. `<element>` is replaced
 * with the captured label (the raw `<element>` only shows in the Manual Steps editor before an
 * element is linked); `${inputValue}` with the captured literal; and a `derivedFromObject`
 * param's fallback token (`${value}` / `${option}`) is rewritten to the object-derived name
 * (`${email_field}`). All other `${param}` tokens survive verbatim.
 */
export function fillDescription(
  sig: ActionSignature,
  slots: { objectName?: string; inputValue?: string },
): string {
  let out = sig.descriptionTemplate
    .replace(/<element>/g, slots.objectName ?? '')
    .replace(/\$\{inputValue\}/g, slots.inputValue ?? '');
  const derivedParam = sig.requires.params?.find(p => p.derivedFromObject);
  if (derivedParam) {
    const derived = deriveParamName(slots.objectName) || derivedParam.name;
    // Rewrite the fallback token (${value}) to the object-derived name (${email_field}).
    // split/join avoids escaping the ${…} for a RegExp.
    out = out.split('${' + derivedParam.name + '}').join('${' + derived + '}');
  }
  return out;
}

/**
 * Render a signature for the ACTION CATALOG / Manual Steps editor surface (a different surface
 * from the recording bake). The editor understands `${param}` tokens (extracted, colored, and
 * auto-created as test data) and shows `<element>` as the raw placeholder the user links an
 * object to — but it does NOT understand the recording-only fill slot `${inputValue}`. So this
 * converts `${inputValue}` to its declared `${param}` form, LEAVING `<element>` and every other
 * `${token}` (incl. a derivedFromObject param's fallback `${value}`/`${option}`) as-is.
 *
 *   type            'Enter ${value} in <element>'            → unchanged
 *   select_option   'Select ${option} from <element>'        → unchanged
 *   verify_text     'Verify <element> contains "${inputValue}"' → 'Verify <element> contains ${expected_text}'
 *   click           'Click <element>'                        → unchanged
 *
 * The quotes a bake template wraps its value in ("${inputValue}") are dropped here: they belong
 * to the recorded literal, whereas a bare ${param} is what the editor extracts as test data.
 */
export function catalogDescription(sig: ActionSignature): string {
  let out = sig.descriptionTemplate;
  // ${inputValue} → the declared value param the captured literal maps to (e.g. expected_text),
  // so the manual template shows an editable ${param} instead of the internal fill slot.
  if (out.includes('${inputValue}')) {
    const valueParam = sig.requires.params?.find(p => p.slot === 'value' && !p.derivedFromObject);
    const token = valueParam ? '${' + valueParam.name + '}' : '';
    // Strip the bake's surrounding quotes first, so the catalog reads `contains ${expected_text}`
    // rather than `contains "${expected_text}"`.
    out = out.split('"${inputValue}"').join(token).replace(/\$\{inputValue\}/g, token);
  }
  return out;
}

/**
 * WEB recorded-action signatures — the full web action catalog.
 *
 * Grouped to mirror actions/index.ts. Actions the recorder emits carry the SAME description
 * the live bake produces (golden-oracle enforced); execution-only actions (which the recorder
 * never records as a step) carry a designed template validated only structurally.
 */
export const WEB_ACTION_SIGNATURES: Record<string, ActionSignature> = {
  // ── Element interaction ────────────────────────────────────────────────────────────────
  click: {
    actionType: 'click',
    descriptionTemplate: 'Click on <element>',
    requires: { object: true },
  },
  type: {
    actionType: 'type',
    descriptionTemplate: 'Enter ${value} in <element>',
    requires: { object: true, params: [{ name: 'value', slot: 'value', derivedFromObject: true }] },
  },
  fill_form: {
    actionType: 'fill_form',
    descriptionTemplate: 'Enter ${value} in <element>',
    requires: { object: true, params: [{ name: 'value', slot: 'value', derivedFromObject: true }] },
  },
  select_option: {
    actionType: 'select_option',
    descriptionTemplate: 'Select ${option} from <element>',
    requires: { object: true, params: [{ name: 'option', slot: 'value', derivedFromObject: true }] },
  },
  hover: {
    actionType: 'hover',
    descriptionTemplate: 'Hover over <element>',
    requires: { object: true },
  },
  drag: {
    actionType: 'drag',
    descriptionTemplate: 'Drag <element> to ${target}',
    requires: { object: true, params: [{ name: 'target', slot: 'value' }] },
  },
  file_upload: {
    actionType: 'file_upload',
    descriptionTemplate: 'Upload ${file_path} to <element>',
    requires: { object: true, params: [{ name: 'file_path', slot: 'value' }] },
  },
  press_key: {
    actionType: 'press_key',
    descriptionTemplate: 'Press ${key_name}',
    requires: { object: false, params: [{ name: 'key_name', slot: 'value' }] },
  },
  dblclick: {
    actionType: 'dblclick',
    descriptionTemplate: 'Double-click on <element>',
    requires: { object: true },
  },
  focus: {
    actionType: 'focus',
    descriptionTemplate: 'Focus on <element>',
    requires: { object: true },
  },
  blur: {
    actionType: 'blur',
    descriptionTemplate: 'Blur <element>',
    requires: { object: true },
  },
  clear: {
    actionType: 'clear',
    descriptionTemplate: 'Clear <element>',
    requires: { object: true },
  },
  // NOTE: `tap` is intentionally NOT declared here — it is a mobile/touch action kept OUT of
  // the web catalog (2026-07-18 fix), so it has no web catalog row to template.

  // ── Mouse (coordinate-based) ───────────────────────────────────────────────────────────
  mouse_click_xy: {
    actionType: 'mouse_click_xy',
    descriptionTemplate: 'Click at (${x}, ${y})',
    requires: { object: false, params: [{ name: 'x', slot: 'value', valueType: 'number' }, { name: 'y', slot: 'value', valueType: 'number' }] },
  },
  mouse_move_xy: {
    actionType: 'mouse_move_xy',
    descriptionTemplate: 'Move mouse to (${x}, ${y})',
    requires: { object: false, params: [{ name: 'x', slot: 'value', valueType: 'number' }, { name: 'y', slot: 'value', valueType: 'number' }] },
  },
  mouse_drag_xy: {
    actionType: 'mouse_drag_xy',
    descriptionTemplate: 'Drag from (${from_x}, ${from_y}) to (${to_x}, ${to_y})',
    requires: {
      object: false,
      params: [
        { name: 'from_x', slot: 'value', valueType: 'number' }, { name: 'from_y', slot: 'value', valueType: 'number' },
        { name: 'to_x', slot: 'value', valueType: 'number' }, { name: 'to_y', slot: 'value', valueType: 'number' },
      ],
    },
  },

  // ── Navigation & lifecycle ─────────────────────────────────────────────────────────────
  navigate: {
    actionType: 'navigate',
    descriptionTemplate: 'Navigate to ${url}',
    requires: { object: false, params: [{ name: 'url', slot: 'value' }] },
  },
  navigate_back: {
    actionType: 'navigate_back',
    // "back" stays adjacent to "Navigate" so the description-inference URL-nav guard
    // (dispatcher.ts) still excludes it; must match deriveWebStepSemantics's bake exactly.
    descriptionTemplate: 'Navigate back in browser',
    requires: { object: false },
  },
  reload: {
    actionType: 'reload',
    descriptionTemplate: 'Reload Browser Page',
    requires: { object: false },
  },
  go_forward: {
    actionType: 'go_forward',
    descriptionTemplate: 'Navigate forward in Browser',
    requires: { object: false },
  },
  close: {
    actionType: 'close',
    descriptionTemplate: 'Closes current active tab',
    requires: { object: false },
  },
  tabs: {
    actionType: 'tabs',
    descriptionTemplate: 'Switch to tab ${tab_index}',
    requires: { object: false, params: [{ name: 'tab_index', slot: 'value', valueType: 'number' }] },
  },
  open_tab: {
    actionType: 'open_tab',
    descriptionTemplate: 'Open new tab',
    requires: { object: false },
  },
  close_tab: {
    actionType: 'close_tab',
    descriptionTemplate: 'Close tab ${tab_index}',
    requires: { object: false, params: [{ name: 'tab_index', slot: 'value', valueType: 'number' }] },
  },

  // ── Verification ───────────────────────────────────────────────────────────────────────
  // The verify family is the ONLY group deriveWebStepSemantics derives from this registry.
  // verify_element_visible is the catalog/legacy action_type AND the canonical `verify_element_state`
  // alias both route to the same replay handler with this exact shape. Declared ONCE (under the
  // catalog action_type verify_element_visible) — no separate `verify_element_state` entry, which
  // would be a pure duplicate. The alias action_type stays registered/executable in the registry.
  verify_element_visible: {
    actionType: 'verify_element_visible',
    descriptionTemplate: 'Verify <element> is ${expected_state}',
    requires: { object: true, params: [{ name: 'expected_state', slot: 'state' }] },
  },
  // The quotes around ${inputValue} are LOAD-BEARING for the recording bake — the saved step
  // reads `Verify Email Field contains "vijay@x.com"`. catalogDescription() drops them so the
  // manual-step template stays the approved `Verify <element> contains ${expected_text}`.
  verify_text_visible: {
    actionType: 'verify_text_visible',
    descriptionTemplate: 'Verify <element> contains "${inputValue}"',
    requires: { object: true, params: [{ name: 'expected_text', slot: 'value' }] },
  },
  verify_value: {
    actionType: 'verify_value',
    descriptionTemplate: 'Verify <element> contains "${inputValue}"',
    requires: { object: true, params: [{ name: 'expected_value', slot: 'value' }] },
  },
  // requires.object:true (the recorded step carries the list element) even though the replay
  // handler's needsLocator is false — reproduces the live bake shape exactly.
  verify_list_visible: {
    actionType: 'verify_list_visible',
    descriptionTemplate: 'Verify <element> contains "${inputValue}"',
    requires: { object: true, params: [{ name: 'expected_text', slot: 'value' }] },
  },
  verify_url_contains: {
    actionType: 'verify_url_contains',
    descriptionTemplate: 'Verify URL contains ${inputValue}',
    requires: { object: false, params: [{ name: 'expected_url', slot: 'value' }] },
  },
  verify_navigation: {
    actionType: 'verify_navigation',
    descriptionTemplate: 'Verify page navigated to ${inputValue}',
    requires: { object: false, params: [{ name: 'expected_url', slot: 'value' }] },
  },
  // The live wording is operator-driven (verifyCompare.ts OPERATOR_PHRASE): `<element> is
  // greater than 100`, `<element> contains …`. The operator is resolved at bake and is neither
  // an element nor a test-data column, so it is left out of the template shape here (kept to
  // `<element>` + the `${expected_value}` param). `tolerance` applies to close_to. The
  // manual-step editor seeds verify_compare from its own parseable sentence — picker subtext only.
  // "equals" — NOT "matches". The frontend seeds the structured compare block by parsing this
  // sentence (parseCompareFromDescription against OPERATOR_PHRASE), and 'matches' is the REGEX
  // operator: it would make every freshly-added step regex-compare, so expected "5" would pass
  // against "15". 'equals' is the phrase for defaultCompareSpec()'s operator. The user picks any
  // other operator from the editor, which rewrites the sentence.
  verify_compare: {
    actionType: 'verify_compare',
    descriptionTemplate: 'Verify <element> equals ${expected_value}',
    requires: {
      object: true,
      params: [
        { name: 'expected_value', slot: 'value' },
        // OPTIONAL: `tolerance` is absent from the template above (verify_compare reads it for the
        // close_to operator only), so the author is never asked for it — without this flag the
        // step editor would demand a `${tolerance}` token the picker never inserts.
        { name: 'tolerance', slot: 'value', valueType: 'number', optional: true },
      ],
    },
  },
  // Param name is load-bearing: handle-dialog.action.ts reads stepValue(ctx,
  // 'expected_dialog_message', …) off the step, and recording bakes that exact name
  // (generateTestSteps ~1260). A manual step must use the SAME name or the value never reaches
  // the handler.
  verify_dialog_message: {
    actionType: 'verify_dialog_message',
    descriptionTemplate: 'Verify dialog message contains "${inputValue}"',
    requires: { object: false, params: [{ name: 'expected_dialog_message', slot: 'value' }] },
  },

  // ── Wait — element state ───────────────────────────────────────────────────────────────
  wait_for_visible: {
    actionType: 'wait_for_visible',
    descriptionTemplate: 'Wait for <element> to be visible',
    requires: { object: true },
  },
  wait_for_hidden: {
    actionType: 'wait_for_hidden',
    descriptionTemplate: 'Wait for <element> to be hidden',
    requires: { object: true },
  },
  wait_for_attached: {
    actionType: 'wait_for_attached',
    descriptionTemplate: 'Wait for <element> to be attached',
    requires: { object: true },
  },
  wait_for_detached: {
    actionType: 'wait_for_detached',
    descriptionTemplate: 'Wait for <element> to be detached',
    requires: { object: true },
  },

  // ── Wait — page level ──────────────────────────────────────────────────────────────────
  wait_timeout: {
    actionType: 'wait_timeout',
    descriptionTemplate: 'Wait ${timeout} ms',
    requires: { object: false, params: [{ name: 'timeout', slot: 'value', valueType: 'number' }] },
  },
  // ${expected_url} is FUNCTIONAL, not decorative: both wait_for_navigation handlers now wait for
  // that URL (page.waitForURL) before the load-state wait. Left empty → load-state wait only,
  // i.e. the previous behaviour.
  wait_for_navigation: {
    actionType: 'wait_for_navigation',
    descriptionTemplate: 'Wait until the ${expected_url} is fully loaded',
    requires: { object: false, params: [{ name: 'expected_url', slot: 'value' }] },
  },
  wait_for_url: {
    actionType: 'wait_for_url',
    descriptionTemplate: 'Wait for URL ${inputValue}',
    requires: { object: false, params: [{ name: 'expected_url', slot: 'value' }] },
  },

  // ── Observation ────────────────────────────────────────────────────────────────────────
  // snapshot / take_screenshot / console_messages / network_requests are BACKEND-ONLY
  // (no `category` on their handlers → not in the catalog), so they are NOT declared here —
  // this registry mirrors the WEB CATALOG. Same reason tap / generate_locator / *_tracing
  // are absent. They stay registered + executable.

  // ── Advanced ───────────────────────────────────────────────────────────────────────────
  handle_dialog: {
    actionType: 'handle_dialog',
    descriptionTemplate: 'Handle dialog',
    requires: { object: false },
  },
  accept_dialog: {
    actionType: 'accept_dialog',
    descriptionTemplate: 'Accept dialog',
    requires: { object: false },
  },
  dismiss_dialog: {
    actionType: 'dismiss_dialog',
    descriptionTemplate: 'Dismiss dialog',
    requires: { object: false },
  },
  // Param name is load-bearing — handle-dialog.action.ts reads stepValue(ctx, 'dialog_prompt', …)
  // and agentOrchestrator bakes that same name when recording a prompt() dialog.
  send_dialog_text: {
    actionType: 'send_dialog_text',
    descriptionTemplate: 'Enter "${inputValue}" in dialog',
    requires: { object: false, params: [{ name: 'dialog_prompt', slot: 'value' }] },
  },
  // evaluate is BACKEND-ONLY (no `category` on its handler → not catalogued), so it is NOT
  // declared here — this registry mirrors the WEB CATALOG. It stays registered + executable.
  run_code: {
    actionType: 'run_code',
    descriptionTemplate: 'Run code',
    requires: { object: false },
  },
  // generate_locator is BACKEND-ONLY (no `category`) → not declared here (see Observation note).
  resize: {
    actionType: 'resize',
    descriptionTemplate: 'Resize viewport to ${width}x${height}',
    requires: { object: false, params: [{ name: 'width', slot: 'value', valueType: 'number' }, { name: 'height', slot: 'value', valueType: 'number' }] },
  },
  scroll: {
    actionType: 'scroll',
    descriptionTemplate: 'Scroll to <element>',
    requires: { object: true },
  },

  // ── PDF ────────────────────────────────────────────────────────────────────────────────
  pdf_save: {
    actionType: 'pdf_save',
    descriptionTemplate: 'Save page as PDF',
    requires: { object: false },
  },
  // start_tracing / stop_tracing are BACKEND-ONLY (no `category`) → not declared here
  // (see the Observation note above).

  // ── Step-handler web actions (catalogued, but NOT playwright element actions) ─────────────
  // SHADOW-ONLY, even more than the rest: their catalog descriptions come from the step-handler
  // definitions (getActionsPayload overrides only the ACTION-handler rows, not step handlers),
  // and their value carriers are runtime/global VARIABLES ($[…] / $(…)) or a window name — not
  // test-data ${params} — so params stay minimal. Declared here purely so the registry covers
  // the FULL web catalog.
  store_run_variable: {
    actionType: 'store_run_variable',
    descriptionTemplate: 'Store text of the <element> to $[variable_name]',
    requires: { object: true },
  },
  // Wording matches store_run_variable except for the $( target — safe because
  // dispatcher.inferActionTypeFromDescription now exempts a $(…)-only description from the
  // "Store text of" → store_run_variable rule (it used to OVERRIDE this step's action_type).
  store_global_variable: {
    actionType: 'store_global_variable',
    descriptionTemplate: 'Store text of the <element> in $(variable_name)',
    requires: { object: true },
  },
  switch_window: {
    actionType: 'switch_window',
    descriptionTemplate: 'Switch to ${window_name} window',
    requires: { object: false, params: [{ name: 'window_name', slot: 'value' }] },
  },
  close_browser: {
    actionType: 'close_browser',
    descriptionTemplate: 'Close browser window',
    requires: { object: false },
  },
};
