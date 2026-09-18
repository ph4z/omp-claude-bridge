import { query, type SettingSource } from "@anthropic-ai/claude-agent-sdk";
import { getBundledModels } from "@oh-my-pi/pi-catalog/models";
import { buildModels, buildRegisteredModels, parseClaudeModelId } from "../src/models.js";

type ServedUsage = {
	contextWindow?: number;
	maxOutputTokens?: number;
};

type ProbeResult = {
	model: string;
	catalogWindow: number;
	sdkAdvertised: boolean | null;
	servedModel?: string;
	servedWindow?: number;
	maxOutputTokens?: number;
	status: "PASS" | "UNAVAILABLE" | "MISMATCH" | "NO_USAGE" | "ERROR";
	error?: string;
};

function newestPerFamily<T extends { id: string }>(models: T[]): T[] {
	const seen = new Set<string>();
	const selected: T[] = [];
	for (const model of models) {
		const parsed = parseClaudeModelId(model.id);
		if (!parsed || seen.has(parsed.family)) continue;
		seen.add(parsed.family);
		selected.push(model);
	}
	return selected;
}

function selectedModels() {
	const all = buildRegisteredModels(buildModels(getBundledModels("anthropic")));
	const args = process.argv.slice(2);
	const explicit = args.filter((arg) => arg !== "--all");

	if (explicit.length > 0) {
		const byId = new Map(all.map((model) => [model.id, model]));
		const missing = explicit.filter((id) => !byId.has(id));
		if (missing.length > 0) {
			throw new Error(`Unknown/not-registered Anthropic model(s): ${missing.join(", ")}`);
		}
		return explicit.map((id) => byId.get(id)!);
	}

	return args.includes("--all") ? all : newestPerFamily(all);
}

function isUnavailableModelError(message: string): boolean {
	return /there's an issue with the selected model/i.test(message) &&
		/may not exist or you may not have access/i.test(message);
}

async function probe(model: { id: string; contextWindow: number | null }): Promise<ProbeResult> {
	const catalogWindow = model.contextWindow;
	if (catalogWindow == null) {
		return {
			model: model.id,
			catalogWindow: 0,
			sdkAdvertised: null,
			status: "ERROR",
			error: "catalogue contextWindow is null",
		};
	}

	const q = query({
		prompt: "Reply exactly OK.",
		options: {
			cwd: process.cwd(),
			model: model.id,
			env: {
				...process.env,
				DISABLE_AUTO_COMPACT: "1",
				CLAUDE_CODE_DISABLE_AUTO_MEMORY: "1",
				CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
			},
			tools: [],
			strictMcpConfig: true,
			settingSources: [] as SettingSource[],
			skills: [],
			persistSession: false,
			maxTurns: 1,
		},
	});

	let sdkAdvertised: boolean | null = null;
	let servedModel: string | undefined;
	let servedWindow: number | undefined;
	let maxOutputTokens: number | undefined;

	try {
		try {
			const supported = await q.supportedModels();
			const values = supported.map((entry: any) => String(entry.value ?? ""));
			sdkAdvertised = values.includes(model.id);
		} catch {
			// supportedModels() is advisory only: older Claude Code versions have
			// omitted aliases they nevertheless accept. The actual probe below is
			// authoritative for this smoke test.
			sdkAdvertised = null;
		}

		for await (const message of q) {
			if (message.type !== "result") continue;
			const usage = (message as any).modelUsage as Record<string, ServedUsage> | undefined;
			if (!usage) continue;
			const entries = Object.entries(usage);
			const selected = entries.find(([id]) => id === model.id) ?? entries[0];
			if (!selected) continue;
			servedModel = selected[0];
			servedWindow = selected[1].contextWindow;
			maxOutputTokens = selected[1].maxOutputTokens;
		}

		if (servedWindow == null) {
			return {
				model: model.id,
				catalogWindow,
				sdkAdvertised,
				servedModel,
				maxOutputTokens,
				status: "NO_USAGE",
				error: "Claude Code returned no modelUsage.contextWindow",
			};
		}

		return {
			model: model.id,
			catalogWindow,
			sdkAdvertised,
			servedModel,
			servedWindow,
			maxOutputTokens,
			status: servedWindow === catalogWindow ? "PASS" : "MISMATCH",
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			model: model.id,
			catalogWindow,
			sdkAdvertised,
			servedModel,
			servedWindow,
			maxOutputTokens,
			status: isUnavailableModelError(message) ? "UNAVAILABLE" : "ERROR",
			error: message,
		};
	} finally {
		try { q.close(); } catch {}
	}
}

function print(results: ProbeResult[]): void {
	const rows = results.map((result) => ({
		model: result.model,
		catalog: result.catalogWindow,
		sdkAdvertised: result.sdkAdvertised == null ? "?" : result.sdkAdvertised ? "yes" : "no",
		servedModel: result.servedModel ?? "?",
		served: result.servedWindow ?? "?",
		maxOutput: result.maxOutputTokens ?? "?",
		status: result.status,
	}));
	console.table(rows);

	for (const result of results) {
		if (result.error) console.error(`${result.model}: ${result.error}`);
	}
}

async function main(): Promise<void> {
	const models = selectedModels();
	if (models.length === 0) throw new Error("No canonical Anthropic models discovered");

	console.log(
		`Probing ${models.length} Claude Code runtime(s). Default selection is the newest canonical model in every discovered family; use --all or explicit ids to override.\n`,
	);

	const results: ProbeResult[] = [];
	for (const model of models) {
		process.stdout.write(`probe ${model.id} ... `);
		const result = await probe(model as { id: string; contextWindow: number | null });
		results.push(result);
		console.log(result.status);
	}
	console.log();
	print(results);

	const available = results.filter((result) => result.status !== "UNAVAILABLE");
	if (available.length === 0) {
		console.error("No probed model was available to this Claude Code account.");
		process.exitCode = 2;
		return;
	}
	if (available.some((result) => result.status !== "PASS")) {
		process.exitCode = 2;
	}
}

await main();
