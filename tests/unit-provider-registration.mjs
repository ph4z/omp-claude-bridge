import assert from "node:assert/strict";
import test from "node:test";
import {
	ACTIVE_STREAM_SIMPLE_KEY,
	runWithInheritedProviderRegistration,
} from "../src/provider-registration.ts";

function makeApi(registrations) {
	return {
		registerProvider(providerId, config) {
			registrations.push({ providerId, config });
		},
		on() {},
		registerTool() {},
	};
}

function makeUpstreamFactory(streamSimple, globalState) {
	return (pi) => {
		if (!globalState[ACTIVE_STREAM_SIMPLE_KEY]) {
			globalState[ACTIVE_STREAM_SIMPLE_KEY] = streamSimple;
			pi.registerProvider("claude-bridge", {
				apiKey: "not-used",
				api: "claude-bridge",
				streamSimple,
			});
		}
	};
}

test("child session re-registers provider while preserving parent streamSimple", () => {
	const globalState = {};
	const registrations = [];
	const parentStream = () => "parent";
	const childStream = () => "child";
	const api = makeApi(registrations);

	runWithInheritedProviderRegistration(
		api,
		makeUpstreamFactory(parentStream, globalState),
		globalState,
	);

	runWithInheritedProviderRegistration(
		api,
		makeUpstreamFactory(childStream, globalState),
		globalState,
	);

	assert.equal(registrations.length, 2);
	assert.equal(registrations[0].providerId, "claude-bridge");
	assert.equal(registrations[1].providerId, "claude-bridge");
	assert.equal(registrations[0].config.streamSimple, parentStream);
	assert.equal(registrations[1].config.streamSimple, parentStream);
	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], parentStream);
});

test("parent guard is restored even when child extension throws", () => {
	const globalState = {};
	const registrations = [];
	const parentStream = () => "parent";
	const api = makeApi(registrations);

	runWithInheritedProviderRegistration(
		api,
		makeUpstreamFactory(parentStream, globalState),
		globalState,
	);

	assert.throws(() =>
		runWithInheritedProviderRegistration(
			api,
			() => {
				throw new Error("boom");
			},
			globalState,
		),
	);

	assert.equal(globalState[ACTIVE_STREAM_SIMPLE_KEY], parentStream);
});
