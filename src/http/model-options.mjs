// SWE-2 and Astra effort is part of the upstream selector, not a token budget.
// Validate before forwarding so the transport cannot silently ignore an effort
// or substitute a different variant after the public route has been selected.
export function modelOptionsError(body) {
  const match = /^(swe-2|gpt-6-astra)-(low|medium|high|xhigh|max)$/.exec(body.model ?? "");
  if (!match) return null;
  const [, family, effort] = match;
  const label = family === "swe-2" ? "SWE-2" : "Astra";
  const choices = family === "swe-2"
    ? "swe-2-medium, swe-2-high, or swe-2-max"
    : "gpt-6-astra-low, gpt-6-astra-medium, gpt-6-astra-high, gpt-6-astra-xhigh, or gpt-6-astra-max";
  for (const value of [
    body.reasoning_effort,
    body.reasoning?.effort,
    body.output_config?.effort,
  ]) {
    if (value !== undefined && value !== effort) {
      return `${label} effort must match the model selector (${effort}). Choose ${choices}; separate effort overrides are not supported.`;
    }
  }
  if (body.thinking !== undefined && (
    body.thinking?.type !== "adaptive" || body.thinking?.budget_tokens !== undefined
  )) {
    return `${label} supports selector-based reasoning or thinking.type=adaptive, not disabled thinking or explicit thinking budgets. Choose ${choices}.`;
  }
  return null;
}
