export { globMatch } from "./glob.ts";
export { BUILT_IN_GUARDS, type ExtraGuard, type GuardResult, guardCheck } from "./guard.ts";
export { MASS_DELETE, massDeleteCheck } from "./mass-delete.ts";
export { matchRules, type RuleHit } from "./match.ts";
export { commandHead, normalizeCommand } from "./normalize.ts";
export {
  appOutbound,
  OUTBOUND_STEPS,
  type OutboundResult,
  type OutboundStep,
  outboundCheck,
  type PushPlan,
  pushPlans,
  stepsSaidIn,
} from "./outbound.ts";
export { isInside, type PathContext, resolveWord } from "./paths.ts";
export { redact } from "./redact.ts";
export { type Segment, splitCommand, UnparsedCommandError } from "./shell.ts";
