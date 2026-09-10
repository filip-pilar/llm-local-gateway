export const providerModels = Object.freeze({
  devin: Object.freeze([
    "swe-1-6-slow",
    "swe-1-7-lightning",
    "swe-2-medium",
    "swe-2-high",
    "swe-2-max",
  ]),
  grok: Object.freeze([
    "grok-4.5",
  ]),
});

export const supportedModels = Object.freeze(
  Object.values(providerModels).flat(),
);

const providersByModel = new Map(
  Object.entries(providerModels).flatMap(([provider, models]) =>
    models.map((model) => [model, provider])),
);

export function providerForModel(model) {
  return providersByModel.get(model) ?? null;
}
