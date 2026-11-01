'use strict';

// The files a build of the app takes from the app folder: `homey app build`,
// `run`, `install` and `publish` all copy them the same way. Read with the
// Homey CLI's own walker and rules (lib/App.js, _getAppSourceFiles), from the
// CLI that `homey` on the PATH runs.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..', '..');

// The folder of the Homey CLI that `homey` on the PATH runs, or null.
function homeyCli() {
  try {
    let dir = path.dirname(fs.realpathSync(execFileSync('which', ['homey'], { encoding: 'utf8' }).trim()));
    while (dir !== path.dirname(dir)) {
      const manifest = path.join(dir, 'package.json');
      if (fs.existsSync(manifest) && JSON.parse(fs.readFileSync(manifest, 'utf8')).name === 'homey') return dir;
      dir = path.dirname(dir);
    }
  } catch (err) {
    // not on the PATH
  }
  return null;
}

function buildFiles() {
  const cli = homeyCli();
  assert.ok(cli && fs.existsSync(path.join(cli, 'lib', 'App.js')), 'the Homey CLI (homey on the PATH) is needed for this test');
  const source = fs.readFileSync(path.join(cli, 'lib', 'App.js'), 'utf8');
  const body = source.slice(source.indexOf('async _getAppSourceFiles()'));
  const list = /const ignoreRules = \[([^\]]*)\]/.exec(body);
  assert.ok(list, 'the CLI still lists its own rules in _getAppSourceFiles');
  assert.match(body.slice(0, 600), /ignoreFiles: \['\.homeyignore', DEFAULT_IGNORE_RULES_FILE\]/);
  const rules = [...list[1].matchAll(/'([^']*)'/g)].map((m) => m[1]);
  const ignoreWalk = require(path.join(cli, 'node_modules', 'ignore-walk'));
  const walker = new ignoreWalk.Walker({
    path: ROOT, ignoreFiles: ['.homeyignore', '$default-ignore-rules'], includeEmpty: true, follow: true,
  });
  walker.onReadIgnoreFile('$default-ignore-rules', rules.join('\r\n'), () => {});
  return new Promise((resolve, reject) => walker.on('done', resolve).on('error', reject).start());
}

module.exports = { ROOT, buildFiles, homeyCli };
