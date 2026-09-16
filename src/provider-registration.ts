export const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

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
 * streamSimple callback.
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

	options.registerProvider(options.providerId, {
		...options.config,
		streamSimple: activeStreamSimple,
	});

	return { isFirstProviderInstance, activeStreamSimple };
}
