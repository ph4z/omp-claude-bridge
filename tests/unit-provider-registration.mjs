import assert from "node:assert/strict";
import test from "node:test";
import {
	ACTIVE_STREAM_SIMPLE_KEY,
	registerSharedProvider,
	releaseSharedProvider,
} from "../src/provider-registration.ts";

test("every session registers while child sessions reuse the first streamSimple", () => {
	const globalState = {};
	const registrations = [];
	const parentStream = () => "parent";
	const childStream = () => "child";

	const parent = registerSharedProvider({
		providerId: "claude-bridge",
		streamSimple: parentStream,
		config: { apiKey: "not-used", api: "claude-bridge" },
		registerProvider: (providerId, config) => registrations.push({ providerId, config }),
		globalState,
	});

	const child = registerSharedProvider({
		providerId: "claude-bridge",
		streamSimple: childStream,
		config: { apiKey: "not-used", api: "claude-bridge" },
		registerProvider: (providerId, config) => registrations.push({ providerId, config }),
		globalState,
	});

	assert.equal(parent.isFirstProviderInstance, true);
	assert.equal(child.isFirstProviderInstance, false);
	assert.equal(registrations.length, 2);
	assert.equal(registrations[0].providerId, "claude-bridge");
	assert.equal(registrations[1].providerId, "claude-bridge");
	assert.equal(registrations[0].config.streamSimple, parentStream);
	assert.equal(registrations[1].config.streamSimple, parentStream);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], parentStream);

	assert.equal(releaseSharedProvider(globalState), false);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], parentStream);
	assert.equal(releaseSharedProvider(globalState), true);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], undefined);
});

test("sessions sharing one module instance each hold their own claim on the registration", () => {
	// OMP re-binds an already-imported extension factory for subagent sessions,
	// so the parent and every subagent register the identical streamSimple.
	const globalState = {};
	const streamSimple = () => "shared";
	const register = () =>
		registerSharedProvider({
			providerId: "claude-bridge",
			streamSimple,
			config: { apiKey: "not-used", api: "claude-bridge" },
			registerProvider: () => {},
			globalState,
		});

	register();
	register();

	assert.equal(
		releaseSharedProvider(globalState),
		false,
		"a subagent leaving must not release state the parent still uses",
	);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], streamSimple);
	assert.equal(releaseSharedProvider(globalState), true);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], undefined);
});

test("an extra shutdown after the last session cannot re-release", () => {
	const globalState = {};
	registerSharedProvider({
		providerId: "claude-bridge",
		streamSimple: () => "only",
		config: { apiKey: "not-used", api: "claude-bridge" },
		registerProvider: () => {},
		globalState,
	});

	assert.equal(releaseSharedProvider(globalState), true);
	assert.equal(releaseSharedProvider(globalState), false);
});
