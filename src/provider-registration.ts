export const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

/**
 * How many OMP sessions currently have this provider bound.
 *
 * Ownership cannot be keyed on streamSimple identity. OMP re-binds an
 * already-imported extension factory for subagent sessions
 * (`preloadedPreparedExtensions`), so the parent session and every subagent
 * share one module evaluation — and therefore one streamSimple object. An
 * identity check would let the first subagent's `session_shutdown` claim
 * ownership and tear down state the parent is still using mid-turn.
 */
const BOUND_SESSION_COUNT_KEY = Symbol.for("claude-bridge:boundSessionCount");

export interface SharedProviderRegistrationOptions<TStream, TConfig extends Record<string, unknown>> {
	providerId: string;
	streamSimple: TStream;
	config: TConfig;
	registerProvider: (providerId: string, config: TConfig & { streamSimple: TStream }) => void;
	globalState?: Record<symbol, unknown>;
}

/**
 * Register the provider for every OMP session while keeping the first
 * streamSimple callback process-wide.
 *
 * OMP child sessions share the parent's ModelRegistry, then clear extension-
 * owned provider registrations before replaying registrations emitted by the
 * child's extension runtime. Skipping registerProvider() in child sessions
 * therefore removes the provider from the shared registry. At the same time,
 * replacing the callback with a child-bound streamSimple breaks the parent's
 * stateful tool-result delivery.
 *
 * The invariant is: every session registers, every session reuses the first
 * streamSimple callback, and shared state is released only once the last bound
 * session has shut down.
 */
export function registerSharedProvider<TStream, TConfig extends Record<string, unknown>>(
	options: SharedProviderRegistrationOptions<TStream, TConfig>,
): { isFirstProviderInstance: boolean; activeStreamSimple: TStream } {
	const globalState = options.globalState ?? (globalThis as Record<symbol, unknown>);
	const existing = globalState[ACTIVE_STREAM_SIMPLE_KEY] as TStream | undefined;
	const isFirstProviderInstance = existing === undefined;
	const activeStreamSimple = existing ?? options.streamSimple;

	if (isFirstProviderInstance) {
		globalState[ACTIVE_STREAM_SIMPLE_KEY] = activeStreamSimple;
	}
	globalState[BOUND_SESSION_COUNT_KEY] = ((globalState[BOUND_SESSION_COUNT_KEY] as number) ?? 0) + 1;

	options.registerProvider(options.providerId, {
		...options.config,
		streamSimple: activeStreamSimple,
	});

	return { isFirstProviderInstance, activeStreamSimple };
}

/**
 * Account for one session shutdown; report whether it was the last bound one.
 *
 * A `true` result means no session can reach the provider any more, so the
 * caller may also drop the state it shares with the registration (see
 * `releaseSharedPromptCaptures`). Every other shutdown only decrements.
 */
export function releaseSharedProvider(
	globalState: Record<symbol, unknown> = globalThis as Record<symbol, unknown>,
): boolean {
	const bound = (globalState[BOUND_SESSION_COUNT_KEY] as number) ?? 0;
	if (bound === 0) return false;
	const remaining = bound - 1;
	if (remaining > 0) {
		globalState[BOUND_SESSION_COUNT_KEY] = remaining;
		return false;
	}

	delete globalState[BOUND_SESSION_COUNT_KEY];
	delete globalState[ACTIVE_STREAM_SIMPLE_KEY];
	return true;
}
