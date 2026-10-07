"use strict";

// System Clock has no server-side gameplay integration. The Launcher delivers
// client/menu.py through the reviewed login-handshake path when the mod is
// enabled, so this loader intentionally does not patch Node's module system.
const MOD_VERSION = "0.3.0";

console.log(`[systemClock] v${MOD_VERSION} active — client menu delivery enabled`);

module.exports = Object.freeze({
  id: "systemclock",
  version: MOD_VERSION,
  active: true,
});
