export const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

type RegisterProvider = (providerId: string, config: Record<string, any>) => unknown;

type ProviderApi = {
	registerProvider: RegisterProvider;
	[key: PropertyKey]: any;
};

/**
 * Run the bridge extension factory for one OMP session.
 *
 * The upstream bridge intentionally skips registerProvider() when another
 * module instance already owns ACTIVE_STREAM_SIMPLE_KEY, because replacing the
 * parent's stateful streamSimple callback breaks tool-result delivery.
 *
 * OMP task subagents, however, share the parent's ModelRegistry and clear
 * extension-owned provider registrations before replaying registrations emitted
 * by the child extension runtime. A child that emits nothing therefore removes
 * claude-bridge from the shared registry and later fails with a misleading
 * "No API key found for claude-bridge" error.
 *
 * For a child session we temporarily clear the guard so the upstream factory
 * emits its normal provider registration, intercept that registration to keep
 * the parent's streamSimple callback, then restore the parent guard. The
 * upstream implementation remains otherwise untouched.
 */
export function runWithInheritedProviderRegistration<TApi extends ProviderApi, TResult>(
	pi: TApi,
	runExtension: (pi: TApi) => TResult,
	globalState: Record<symbol, any> = globalThis as Record<symbol, any>,
): TResult {
	const parentStreamSimple = globalState[ACTIVE_STREAM_SIMPLE_KEY];
	if (parentStreamSimple === undefined) {
		return runExtension(pi);
	}

	globalState[ACTIVE_STREAM_SIMPLE_KEY] = undefined;

	const childApi = new Proxy(pi, {
		get(target, property) {
			if (property === "registerProvider") {
				return (providerId: string, config: Record<string, any>) =>
				target.registerProvider.call(target, providerId, {
					...config,
					streamSimple: parentStreamSimple,
				});
			}

			const value = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) as TApi;

	try {
		return runExtension(childApi);
	} finally {
		globalState[ACTIVE_STREAM_SIMPLE_KEY] = parentStreamSimple;
	}
}
