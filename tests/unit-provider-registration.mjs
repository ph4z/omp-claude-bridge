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

	assert.equal(releaseSharedProvider(childStream, globalState), false);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], parentStream);
	assert.equal(releaseSharedProvider(parentStream, globalState), true);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], undefined);
});
