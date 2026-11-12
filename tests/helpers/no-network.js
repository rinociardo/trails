// Loaded before every test file (see "test" in package.json): the network is off,
// so no test can reach the Trails relay, openrouteservice or anything else and use
// the shared quota. A test that needs answers stubs fetch itself (relay.test.js) or
// uses the recorded ones (helpers/recorded.js); both put this back afterwards.

globalThis.fetch = async (url) => {
    throw new Error(`network is off in tests: ${url}`);
};
