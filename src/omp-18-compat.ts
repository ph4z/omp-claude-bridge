import * as hostPiAi from "@oh-my-pi/pi-ai";
import { compact as hostCompact } from "@oh-my-pi/pi-agent-core/compaction";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import type { DiscoverableCatalogModel } from "./models.js";

type HostPiAiCompatibility = typeof hostPiAi & {
	getModels(provider: "anthropic"): readonly DiscoverableCatalogModel[];
};

/**
 * OMP 18.2.6 serves canonical pi-ai root imports from its in-process
 * compatibility module. `getModels` is the historical catalogue alias that
 * compatibility surface intentionally adds; using it keeps model discovery on
 * the host's catalogue instance without importing pi-catalog into the plugin.
 */
export function getHostAnthropicModels(): readonly DiscoverableCatalogModel[] {
	const getModels = (hostPiAi as HostPiAiCompatibility).getModels;
	if (typeof getModels !== "function") {
		throw new Error("OMP host pi-ai compatibility surface does not expose getModels()");
	}
	return getModels("anthropic");
}

/** Create an event stream from the canonical host pi-ai module instance. */
export function createHostAssistantMessageEventStream(): hostPiAi.AssistantMessageEventStream {
	if (typeof hostPiAi.createAssistantMessageEventStream === "function") {
		return hostPiAi.createAssistantMessageEventStream();
	}
	// Compatibility with older hosts covered by the existing peer range.
	const LegacyAssistantMessageEventStream = (
		hostPiAi as unknown as {
			AssistantMessageEventStream: new () => hostPiAi.AssistantMessageEventStream;
		}
	).AssistantMessageEventStream;
	return new LegacyAssistantMessageEventStream();
}

type CompactFn = typeof hostCompact;

/**
 * Preserve the bridge's low-level compaction takeover. ExtensionContext.compact
 * cannot inject `completeImpl`, so it is not semantically equivalent.
 */
export function compactWithCompleteImpl(
	preparation: Parameters<CompactFn>[0],
	model: Parameters<CompactFn>[1],
	customInstructions: Parameters<CompactFn>[3],
	signal: Parameters<CompactFn>[4],
	completeImpl: NonNullable<Parameters<CompactFn>[5]>["completeImpl"],
	compactImpl: CompactFn = hostCompact,
): ReturnType<CompactFn> {
	return compactImpl(preparation, model, undefined, customInstructions, signal, { completeImpl });
}

/** Build an enum with OMP's injected TypeBox facade. */
export function stringEnum<const Values extends readonly (string | number)[]>(
	Type: ExtensionAPI["typebox"]["Type"],
	values: Values,
	description: string,
) {
	return Type.Enum(values, { description });
}

/** Project the active branch exactly as OMP's public buildSessionContext does. */
export function projectAskClaudeContext<TBranch, TMessages>(
	isolated: boolean,
	branch: TBranch,
	buildSessionContext: (branch: TBranch) => { messages: TMessages },
): TMessages | undefined {
	return isolated ? undefined : buildSessionContext(branch).messages;
}
