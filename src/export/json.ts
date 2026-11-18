import type { AnalysisReport } from '../adapters/simplifyqa/failureReportModel.js';

/** `analysis.json`: the report model, pretty-printed. */
export function reportToJson(r: AnalysisReport): string {
  return JSON.stringify(r, null, 2);
}
