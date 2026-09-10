// SWE-2 effort is part of the upstream selector, not a separate token budget.
// Validate before forwarding so the transport cannot silently ignore an effort
// or substitute a different variant after the public route has been selected.
export function modelOptionsError(body) {
  if (!/^swe-2-(medium|high|max)$/.test(body.model ?? "")) return null;
  const effort = body.model.slice("swe-2-".length);
  for (const value of [
    body.reasoning_effort,
    body.reasoning?.effort,
    body.output_config?.effort,
  ]) {
    if (value !== undefined && value !== effort) {
      return `SWE-2 effort must match the model selector (${effort}). Choose swe-2-medium, swe-2-high, or swe-2-max; separate effort overrides are not supported.`;
    }
  }
  if (body.thinking !== undefined && (
    body.thinking?.type !== "adaptive" || body.thinking?.budget_tokens !== undefined
  )) {
    return "SWE-2 supports selector-based reasoning or thinking.type=adaptive, not disabled thinking or explicit thinking budgets. Choose swe-2-medium, swe-2-high, or swe-2-max.";
  }
  return null;
}
