import { PREFLIGHT_MAX_TOKENS } from '../constants';
import { errorText } from '../errors';
import { INHERIT_MODEL, isAlias } from '../roster/model';
import type { ModelCompleteRequest, ModelCompleteResult } from 'claude-code';

// §5.2 step 2: the models to call, each once. `inherit` names no model to call: the session runs on its model
// already, and the call takes only an alias or a full id.
export const preflightModels = (models: readonly string[]): string[] =>
  [...new Set(models)].filter((model) => model !== INHERIT_MODEL);

// §5.2 step 2: one 1-token call for each distinct model finds a model that cannot run before any review.
export const preflightRequest = (model: string): ModelCompleteRequest => ({
  model,
  prompt: 'Reply with one word.',
  maxTokens: PREFLIGHT_MAX_TOKENS,
});

// The engine rejects the call for a model it refuses (§6.2); of the API errors only `model_not_found` speaks
// about the model. Any other error is left to the reviews (§12).
export const preflightProblem = (result: ModelCompleteResult): string | undefined =>
  !result.isAnswered && result.reason === 'api-error' && result.error === 'model_not_found'
    ? 'the preflight call gave model_not_found'
    : undefined;

// §6.2, §12.2: under an `availableModels` allowlist the call of a blocked alias rejects, but the spawn steps the
// alias down to the newest allowed model of its family (live probe rf-stepdown-review), and the review-time
// compare takes that model. So a reject is a `no_model` reason only for a full id.
export const preflightReject =
  (model: string) =>
  (error: unknown): string | undefined =>
    isAlias(model) ? undefined : errorText(error);
