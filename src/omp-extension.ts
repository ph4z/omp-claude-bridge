import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";
import bridgeExtension from "./index.js";
import { runWithInheritedProviderRegistration } from "./provider-registration.js";

export default function ompClaudeBridgeExtension(pi: ExtensionAPI) {
	return runWithInheritedProviderRegistration(
		pi,
		bridgeExtension,
	);
}
