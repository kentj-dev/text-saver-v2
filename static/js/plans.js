export const DEFAULT_PLAN_ID = 'free';

export const PLAN_LIMITS = Object.freeze({
  free: Object.freeze({
    maxCharactersPerTab: 10000,
    maxLinesPerTab: 5000,
  }),
});

export function getPlanLimits(planId = DEFAULT_PLAN_ID) {
  return PLAN_LIMITS[planId] || PLAN_LIMITS[DEFAULT_PLAN_ID];
}
