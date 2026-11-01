'use strict';

const fs = require('fs');
const path = require('path');

// Fake devices, for development only (lib/fake/): they are added as usual,
// answer through a fake network of their own, and never send anything on the
// radio. lib/fake/ is in .homeyignore, so no build made from the app folder
// has them; dev/run-with-fakes.sh runs a copy of the app that lets it in.
// Never use --skip-build (`homey app run` or `homey app install`): the Homey
// CLI then packs the app folder as it is, without .homeyignore, so lib/fake/
// and the folders it leaves out (progress/, docs/) go to Homey too.
// This file is all the published app has of them: how a fake device is
// known, and the loading, which needs both DEBUG=1 (set by `homey app run`)
// and lib/fake/.

// A fake device's id: this, then the name it was found by.
const FAKE_ID_PREFIX = 'fake:';
const FAKE_DIR = path.join(__dirname, 'fake');

function isFakeId(id) {
  return String(id || '').startsWith(FAKE_ID_PREFIX);
}

function isFakeDevice(device) {
  return typeof device.getData === 'function' && isFakeId((device.getData() || {}).id);
}

// The fake devices of a run with `homey app run`, or null: always without
// DEBUG=1, and when the build has no lib/fake/.
function loadFakes(app, { env = process.env, dir = FAKE_DIR } = {}) {
  if (env.DEBUG !== '1') return null;
  if (!fs.existsSync(path.join(dir, 'index.js'))) {
    app.log('fake devices: none in this build');
    return null;
  }
  return require(dir).start(app);
}

module.exports = {
  FAKE_ID_PREFIX, isFakeDevice, isFakeId, loadFakes,
};
