'use strict';

// What the texts say about the network password (2.4.1). The warnings on a
// tile are short (Homey shows them only briefly). The explanation, turn
// "Network Isolation" off first or enter the password in every dimmer, is in
// the settings hint, the READMEs and the timeline notification. README says
// one thing about 1234. Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

const read = (file) => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const en = JSON.parse(read('locales/en.json'));
const no = JSON.parse(read('locales/no.json'));
const network = JSON.parse(read('.homeycompose/drivers/settings/network.json'));
const hint = network.children.find((setting) => setting.id === 'passphrase').hint;
const readme = read('README.md');
const setup = readme.slice(readme.indexOf('## Setup'), readme.indexOf('## How it works'));

const EVERY_DIMMER = /every\s+dimmer|hver\s+dimmer/;
const WARNING_MAX = 80;

// Every text that explains the fix, and the words for "every dimmer".
const advice = [
  ['README.md', setup],
  ['README.txt', read('README.txt')],
  ['README.no.txt', read('README.no.txt')],
  ['network.json hint en', hint.en],
  ['network.json hint no', hint.no],
  ['timeline en', en.notification.passwordWrong],
  ['timeline no', no.notification.passwordWrong],
];

// The warnings a dimmer's tile can show.
const warnings = [];
for (const [language, locale] of [['en', en], ['no', no]]) {
  for (const key of ['passwordWrong', 'waitingForStatus', 'notHeard']) {
    warnings.push([`${language} device.${key}`, locale.device[key]]);
  }
}

test('the settings hint, the READMEs and the timeline say: the same password in every dimmer', () => {
  for (const [name, text] of advice) assert.match(text, EVERY_DIMMER, name);
});

test('there, turning Network Isolation off comes first, entering the password second', () => {
  for (const [name, text] of advice) {
    const isolation = text.indexOf('Network Isolation');
    assert.ok(isolation >= 0 && isolation < text.search(EVERY_DIMMER), name);
  }
});

test(`warnings are at most ${WARNING_MAX} characters, without the long explanation`, () => {
  for (const [name, text] of warnings) {
    assert.ok(text.length > 0 && text.length <= WARNING_MAX, `${name}: ${text.length}`);
    assert.doesNotMatch(text, /Network Isolation/, name);
    assert.doesNotMatch(text, EVERY_DIMMER, name);
  }
});

test('the READMEs quote the warning as it is', () => {
  assert.ok(setup.replace(/\s+/g, ' ').includes(`"${en.device.passwordWrong}"`));
  assert.ok(read('README.txt').includes(`"${en.device.passwordWrong}"`));
  assert.ok(read('README.no.txt').includes(`"${no.device.passwordWrong}"`));
});

test('a wrong password gives a warning, and no text says the dimmers become unavailable', () => {
  for (const [name, text] of [...advice, ...warnings]) assert.doesNotMatch(text, /unavailable|utilgjengelig/i, name);
});

test('README says one thing about 1234: the passphrase, unless Network Isolation is on', () => {
  assert.doesNotMatch(readme, /most installations|usually/i);
  const step = setup.slice(setup.indexOf('\n2. '), setup.indexOf('\n3. '));
  assert.equal(setup.split('1234').length, step.split('1234').length);
  assert.match(step, /`1234`, which the SG app\s+sets unless \*\*Network Isolation\*\* is on/);
});

test('the timeline notification names the app and the problem, in both languages', () => {
  assert.match(en.notification.passwordWrong, /^Possibly wrong network password in SG LEDDim\./);
  assert.match(no.notification.passwordWrong, /^Mulig feil nettverkspassord i SG LEDDim\./);
});

test('straight quotes only, in every text', () => {
  for (const [name, text] of [...advice, ...warnings, ['README.md', readme]]) {
    assert.doesNotMatch(text, /[“”‘’«»]/, name);
  }
});
