import type { ActionDef, Step } from '../../domain/types.js';
import { WEB_ACTION_SIGNATURES } from '../../vendor/actionSignatures.js';

export type WalnutPlatform = 'web' | 'android' | 'ios' | 'api' | 'database' | 'mainframe';

/**
 * Static per-technology action-type catalogs. Used as the whole `actionsCatalog()`
 * answer for android/api/database/mainframe (there is no live/per-org source for
 * those) and as the `web` fallback when the live per-org `GET /api/actions` catalog
 * is unavailable (see `WalnutAdapter.actionsCatalog` in adapter.ts).
 *
 * Source (copied verbatim -- do not invent action names):
 *  - web: walnut-mcp/modules/config/action_types.py, VALID_ACTION_TYPES (lines 12-36)
 *    -- the 41 canonical action types mirroring the agent's registered Playwright
 *    tool handlers.
 *  - android: walnut-mcp/modules/config/platform_action_types.py,
 *    ANDROID_ACTION_TYPES (lines 44-91) -- 75 Appium actions.
 *  - api: walnut-mcp/modules/config/platform_action_types.py,
 *    API_ACTION_TYPES (line 148).
 *  - database: walnut-mcp/modules/config/platform_action_types.py,
 *    DATABASE_ACTION_TYPES (line 220).
 *  - ios: NOT from platform_action_types.py, which has no iOS frozenset. Derived from the AGENT's
 *    own IOS_TOOL_REGISTRY (walnut-agent src/mcp/ios/toolRegistry.ts) -- every entry with
 *    `recordable: true`, its `actionType` prefixed `ios_`. That registry is what decides which tool
 *    calls become steps, so it is the only honest source: an action the recorder can emit but this
 *    list omits blocks tc_save, and one listed here that the recorder never emits is dead weight.
 *    The `ios_` prefix is the established convention, not a guess -- the agent's toolAliases.ts maps
 *    catalog action_types to tools in exactly this form (`ios_start_app` -> `ios_launch_app`).
 *  - mainframe: no frozenset for this platform exists in either source file --
 *    left empty rather than guessed (spec §6A documents a Walnut-only mainframe
 *    step_type, but platform_action_types.py has no corresponding action-type set).
 *
 * WHY AN EMPTY LIST IS NOT A SAFE DEFAULT (the bug that motivated the iOS entry): validate.ts gates
 * on `catalog.size &&`, so an unknown platform falls to `?? new Set()` and every step passes
 * unvalidated. iOS was worse than that -- it had no platform at all, so the agent stamped its steps
 * `stepType: 'web'` and they were validated against the WEB catalog, which has no app-launch action
 * of any kind. `ios_start_app` was therefore rejected outright and the only way to save an iOS
 * recording was to DELETE its launch step, losing the bundle id from the saved test case.
 */
/**
 * The walnut-mcp copy of the web catalog (41 types). Kept verbatim as its own const
 * because it is a COPY of an external source; the live web catalog below unions it
 * with the agent's own signature table instead of editing this list by hand.
 */
const WALNUT_MCP_WEB_ACTIONS: string[] = [
    // Navigation
    'navigate', 'navigate_back', 'go_forward', 'reload', 'close', 'tabs',
    // Input
    'click', 'dblclick', 'type', 'fill_form', 'select_option',
    'press_key', 'tap', 'hover', 'focus', 'blur',
    // Mouse coordinate
    'mouse_click_xy', 'mouse_drag_xy', 'mouse_move_xy',
    // Drag & Drop
    'drag',
    // File
    'file_upload',
    // Verification
    'verify_element_visible', 'verify_text_visible', 'verify_value',
    'verify_url_contains', 'verify_list_visible', 'verify_navigation',
    // Wait
    'wait_for_visible', 'wait_for_hidden', 'wait_for_navigation',
    'wait_for_url', 'wait_for_attached', 'wait_for_detached', 'wait_timeout',
    // Advanced
    'evaluate', 'run_code', 'handle_dialog',
    // Layout
    'scroll', 'resize', 'pdf_save',
    // API
    'api_call',
];

/**
 * The web catalog the validator and `actions_catalog` both answer from: the
 * walnut-mcp copy UNIONED with every actionType the agent itself can bake
 * (WEB_ACTION_SIGNATURES -- the same table the recorder fills descriptions from).
 *
 * Why the union rather than a longer hand-kept list: the copy above froze at 41
 * types and the agent has since grown 12 more, so a recording that used any of
 * them was reported as INVALID by our own validator -- `verify_compare` and
 * `store_run_variable` are exposed MCP tools, and every draft containing one came
 * back `validation ✗ -- actionType "verify_compare" not in catalog`. Deriving from
 * the signature table means a future action the agent learns to bake is valid here
 * the moment it has a signature, with no second list to remember.
 */
const WEB_ACTIONS: string[] = [
  ...new Set([...WALNUT_MCP_WEB_ACTIONS, ...Object.keys(WEB_ACTION_SIGNATURES)]),
];

export const WALNUT_ACTIONS: Record<WalnutPlatform, string[]> = {
  web: WEB_ACTIONS,
  android: [
    // App lifecycle
    'android_start_app', 'android_close_app', 'android_reset_app',
    'android_install_app', 'android_uninstall_app', 'android_switch_app',
    'android_is_app_installed',
    // Interaction
    'android_click', 'android_tap', 'android_longpress', 'android_type',
    'android_clear', 'android_click_by_text', 'android_click_by_image',
    'android_click_if_present', 'android_drag_drop',
    'android_hide_keyboard', 'android_press_key',
    'android_pinch_in', 'android_pinch_out',
    // Scroll & Swipe
    'android_scroll_to_element', 'android_scroll_to_text',
    'android_scroll_to_top', 'android_scroll_to_bottom',
    'android_scroll_left', 'android_scroll_right',
    'android_scroll_to_element_and_click',
    'android_scroll_until_element_gone', 'android_scroll_until_text_gone',
    'android_swipe', 'android_swipe_by_direction',
    // Navigation
    'android_back', 'android_home', 'android_recent_apps',
    'android_open_notification', 'android_switch_context',
    'android_get_contexts', 'android_get_current_context',
    // Verification
    'android_validate_text', 'android_validate_partial_text',
    'android_validate_by_text', 'android_validate_by_image',
    'android_wait_for_element', 'android_wait_for_element_gone',
    'android_wait_for_text', 'android_wait_for_text_gone',
    'android_is_element_visible', 'android_is_element_enabled',
    'android_is_element_checked', 'android_is_element_clickable',
    'android_is_element_disabled', 'android_is_element_selected',
    'android_is_element_not_visible', 'android_is_element_not_checked',
    'android_is_element_not_selected',
    // Data retrieval
    'android_get_text', 'android_get_attribute',
    // Device controls
    'android_take_screenshot', 'android_snapshot',
    'android_rotate_screen', 'android_device_info',
    'android_lock', 'android_unlock', 'android_is_locked',
    // Network
    'android_wifi_status', 'android_toggle_wifi',
    'android_data_status', 'android_toggle_data',
    'android_bluetooth_status', 'android_toggle_bluetooth',
    'android_airplane_mode_status',
    // File operations
    'android_push_file', 'android_pull_file',
    // ADB
    'android_adb_command', 'android_type_adb',
  ],
  // iOS — the 36 recordable entries of the agent's IOS_TOOL_REGISTRY, `ios_`-prefixed. Grouped the
  // way the registry groups them so the two can be diffed by eye.
  ios: [
    // App lifecycle. ios_start_app is the one that matters most: it carries the BUNDLE ID, and
    // without it in this list an iOS recording cannot be saved with its launch step intact.
    'ios_start_app', 'ios_close_app', 'ios_switch_app',
    // Interaction
    'ios_click', 'ios_double_tap', 'ios_touch_and_hold', 'ios_type', 'ios_clear', 'ios_submit',
    'ios_swipe', 'ios_swipe_by_direction',
    // Scroll & find
    'ios_scroll_to_element', 'ios_scroll_to_element_and_click', 'ios_scroll_to_text',
    'ios_scroll_until_element_gone', 'ios_scroll_until_text_gone',
    // Verifications — the assertions that make a recording a test
    'ios_verify_visible', 'ios_verify_not_visible', 'ios_verify_text', 'ios_verify_partial_text',
    'ios_verify_enabled', 'ios_verify_disabled', 'ios_verify_selected', 'ios_verify_not_selected',
    'ios_verify_screen_lock', 'ios_validate_by_image', 'ios_wait_for_element',
    // Reads that still record a step (get_text/get_attribute are recordable in the registry)
    'ios_get_text', 'ios_get_attribute',
    // Device & system. Back and App Switcher are GESTURES on iOS, not buttons, but they record as
    // ordinary steps.
    'ios_home', 'ios_back', 'ios_app_switcher', 'ios_press_button', 'ios_rotate_screen',
    'ios_hide_keyboard', 'ios_alert',
  ],
  api: ['api_call'],
  database: ['database_query'],
  mainframe: [],
};

/** Flattens a per-platform action-type catalog into `ActionDef[]`, tagging every entry. */
export function actionDefsFrom(catalog: Record<WalnutPlatform, string[]>): ActionDef[] {
  return (Object.entries(catalog) as Array<[WalnutPlatform, string[]]>).flatMap(([platform, actionTypes]) =>
    actionTypes.map((actionType) => ({ actionType, platform })),
  );
}

// Precomputed once at module load -- every draft-tool validation call shares
// these Sets rather than rebuilding them per call.
const CATALOG_SETS: Record<WalnutPlatform, Set<string>> = Object.fromEntries(
  (Object.entries(WALNUT_ACTIONS) as Array<[WalnutPlatform, string[]]>).map(([platform, list]) => [platform, new Set(list)]),
) as Record<WalnutPlatform, Set<string>>;

/**
 * The single shared `catalogFor` callback every offline draft tool passes to
 * `validateTestCase` -- no network, no adapter, just the static WALNUT_ACTIONS
 * table above. Maps a neutral `Step.stepType` to its WALNUT_ACTIONS bucket;
 * `control_flow` is exempted by `validateTestCase` itself before this is ever
 * consulted, and a stepType with no offline vocabulary (`function`) yields an
 * empty Set, which `validateTestCase` treats as "nothing to check" rather than
 * "nothing is valid".
 */
export function offlineCatalogFor(step: Step): Set<string> {
  return CATALOG_SETS[step.stepType as WalnutPlatform] ?? new Set();
}
