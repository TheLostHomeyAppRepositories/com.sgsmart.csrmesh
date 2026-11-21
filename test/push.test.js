'use strict';

// LEDDim Smart Push and TW LEDDim Smart Push, one driver per product as the
// user sees it: their own driver sg_push, "LEDDim Smart Push", with on/off
// and dim, its icon, images and guide picture. Assumed to be set and read as
// LEDDim Smart (FF03, FF04, FF05): not tried with a device. The colour
// temperature of a TW Push is not set (test/never-sent.test.js).
// Made-up values: the location id 0x5a3c and the mesh ids.
// Run with: node --test test/*.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const fake = require('./helpers/fake-homey');

fake.install();

const {
  PUSH_PREFIXES, canBeBridge, csrDriverFor, csrProductForName, driverForType,
} = require('../lib/sgProducts');
const { foundNote, laterFindings, withStates } = require('../lib/csrPairing');
const SGCsrDevice = require('../lib/SGCsrDevice');
const SGPushDevice = require('../drivers/sg_push/device');
const SGPushDriver = require('../drivers/sg_push/driver');
const SGPillDriver = require('../drivers/sg_pill/driver');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const LOC = 0x5a3c;
const node = (meshId, name) => ({
  meshId, name, product: csrProductForName(name), location: LOC,
});

test('the Push dimmers (@MK, @MU, @SK, @GK) are added with sg_push, by their name and by their type in the SG account', () => {
  assert.deepEqual(PUSH_PREFIXES, ['@MK', '@MU', '@SK', '@GK']);
  for (const prefix of PUSH_PREFIXES) {
    const product = csrProductForName(`${prefix}1A2B`);
    assert.equal(product.kind, 'dimmable', prefix);
    assert.equal(product.form, 'push', prefix);
    assert.equal(product.icon, null, `${prefix}: listed with the driver icon`);
    assert.equal(csrDriverFor(product), 'sg_push', prefix);
    assert.ok(canBeBridge(`${prefix}1A2B`), `${prefix} may carry Homey's link`);
  }
  assert.deepEqual(PUSH_PREFIXES.map((prefix) => csrProductForName(`${prefix}1A2B`).tunableWhite), [false, true, true, true]);
  for (const type of [12, 25, 1012, 2012]) assert.equal(driverForType(type), 'sg_push', `type ${type}`);
});

test('sg_push: "LEDDim Smart Push", a light with on/off and dim, the pairing of sg_pill, the network settings, the Pill\'s device class', () => {
  const compose = JSON.parse(read('drivers/sg_push/driver.compose.json'));
  const pill = JSON.parse(read('drivers/sg_pill/driver.compose.json'));
  assert.deepEqual(compose.name, { en: 'LEDDim Smart Push', no: 'LEDDim Smart Push' });
  assert.equal(compose.class, 'light');
  assert.deepEqual(compose.capabilities, ['onoff', 'dim']);
  assert.deepEqual(compose.pair, pill.pair, 'the same pairing views as sg_pill');
  assert.deepEqual(compose.images, pill.images, 'its own images, at the same paths in its assets');
  assert.deepEqual(JSON.parse(read('drivers/sg_push/driver.settings.compose.json')), [{ $extends: 'network' }]);
  assert.equal(read('drivers/sg_push/pair/guide.html'), read('drivers/sg_pill/pair/guide.html'), 'the shared guide');
  assert.equal(SGPushDevice, SGCsrDevice);
  const app = JSON.parse(read('app.json'));
  const built = app.drivers.find((driver) => driver.id === 'sg_push');
  assert.ok(built, 'in app.json');
  assert.deepEqual(built.capabilities, ['onoff', 'dim']);
  assert.ok(!JSON.stringify(built).includes('light_temperature'), 'no colour temperature');
});

// Homey: the-basics/devices.md (the driver icon at assets/icon.svg) and
// app-store/guidelines.md (driver images 75 x 75, 500 x 500 and 1000 x 1000).
test('the Push icon, images and guide picture are where Homey looks for them, with the sizes Homey asks for', () => {
  const icon = read('drivers/sg_push/assets/icon.svg');
  assert.match(icon, /^<svg [^>]*viewBox="0 0 960 960"/, 'a 960 x 960 canvas');
  assert.doesNotMatch(icon, /<image|<script|base64|href="http/i, 'shapes only');
  assert.ok(!fs.existsSync(path.join(ROOT, 'drivers/sg_push/assets/icons')), 'sg_push lists its devices with the driver icon');
  // The width and height of a PNG, from its IHDR chunk.
  const size = (file) => {
    const png = fs.readFileSync(path.join(ROOT, file));
    assert.equal(png.subarray(1, 4).toString('latin1'), 'PNG', file);
    return [png.readUInt32BE(16), png.readUInt32BE(20)];
  };
  const sizes = { small: [75, 75], large: [500, 500], xlarge: [1000, 1000] };
  for (const [name, expected] of Object.entries(sizes)) {
    assert.deepEqual(size(`drivers/sg_push/assets/images/${name}.png`), expected, name);
  }
  assert.deepEqual(size('drivers/sg_push/assets/guide/guide.png'), size('drivers/sg_pill/assets/guide/guide.png'), 'the guide picture as the Pill\'s');
  for (const file of ['assets/icon.svg', 'assets/images/small.png', 'assets/images/large.png', 'assets/images/xlarge.png', 'assets/guide/guide.png']) {
    assert.equal(fs.statSync(path.join(ROOT, 'drivers/sg_push', file)).mode & 0o777, 0o644, file);
  }
});

// A driver's pairing search with a scan that saw these names and FF11
// answers from these nodes.
async function search(Driver, names, nodes) {
  const app = {
    logs: [],
    errors: [],
    seq: 0x800000,
    log(...args) { app.logs.push(args.join(' ')); },
    error(...args) { app.errors.push(args.join(' ')); },
    getNetworkKey: () => Buffer.alloc(16),
    nextSeq() { app.seq += 1; return app.seq; },
    bridge: { send: async () => ({ ok: true }) },
    _devices: () => [],
    locationFor: () => null,
  };
  app.csr = fake.fakeCsr(nodes);
  const advertisements = names.map((name, i) => ({ uuid: `02000000000${i}`, localName: name, rssi: -60 }));
  const driver = new Driver({ homey: fake.listenAtOnce(fake.fakeHomey(app, { ble: { discover: async () => advertisements } })) });
  driver.getDevices = () => [];
  return { driver, result: await driver._search() };
}

test('pairing: sg_push lists a Push with on/off and dim and the driver\'s icon; one seen without an answer is not offered', async () => {
  const { driver, result } = await search(SGPushDriver, ['@SK1A2B', '@MK3C4D', '@GK5E6F'],
    [node(0x0123, '@SK1A2B'), node(0x0124, '@MK3C4D')]);
  assert.deepEqual(result.devices.map((d) => d.data.id).sort(), ['@MK3C4D', '@SK1A2B']);
  const push = result.devices.find((d) => d.data.id === '@SK1A2B');
  assert.equal(push.name, 'LEDDim Smart Push 1A2B');
  assert.equal(push.icon, undefined);
  assert.deepEqual(push.capabilities, ['onoff', 'dim']);
  assert.deepEqual(push.store, {
    meshId: 0x0123, prefix: '@SK', kind: 'dimmable', tunableWhite: true, locationId: LOC,
  });
  assert.equal(result.devices.find((d) => d.data.id === '@MK3C4D').store.tunableWhite, false);
  assert.deepEqual(result.found.map((f) => [f.name, f.state]).sort(),
    [['@GK5E6F', 'noAnswer'], ['@MK3C4D', 'add'], ['@SK1A2B', 'add']]);
  assert.ok(driver.logs.some((line) => line.includes('@SK Gen3 dimmable add')));
});

test('pairing: a Push already added is not offered again; only a Pill found in sg_push says where it is added', async () => {
  const { driver } = await search(SGPushDriver, [], []);
  driver.getDevices = () => [{ getData: () => ({ id: '@SK1A2B' }) }];
  driver.homey.app.csr = fake.fakeCsr([node(0x0123, '@SK1A2B')]);
  const again = await driver._search();
  assert.deepEqual(again.devices, []);
  assert.deepEqual(again.found.map((f) => f.state), ['added']);
  const pillOnly = await search(SGPushDriver, ['@SC1A2B'], [node(0x0125, '@SC1A2B')]);
  assert.deepEqual(pillOnly.result.devices, []);
  // The fake Homey's __ gives the key alone; the tokens are in the test below.
  assert.deepEqual(pillOnly.driver._listFrom(pillOnly.result), { error: 'found, none to add', text: 'pair.found.noPush pair.found.goToPill' });
});

// What a driver's list says when it found these and nothing of its own.
const note = (driverId, ...names) => foundNote(withStates(laterFindings([], names.map((name, i) => node(0x0130 + i, name))), driverId, new Set()),
  (key, tokens) => `${key}${tokens ? ` ${JSON.stringify(tokens)}` : ''}`, driverId);

test('the references in the pairing: a Push found elsewhere goes to "LEDDim Smart Push", and sg_push names what it found of others', () => {
  const push = 'pair.found.goToPush {"products":"LEDDim Smart Push"}';
  assert.equal(note('sg_mesh', '@SK1A2B'), `pair.found.noDimmer ${push}`);
  assert.equal(note('sg_pill', '@MK1A2B'), `pair.found.noPill ${push}`);
  assert.equal(note('sg_din', '@GK1A2B'), `pair.found.noDin ${push}`);
  assert.equal(note('sg_plug', '@SK1A2B'), `pair.found.noPlug ${push}`);
  assert.equal(note('sg_thermostat', '@SK1A2B'), `pair.found.noThermostat ${push}`);
  assert.equal(note('sg_pill', '@MU1A2B'), 'pair.found.noPill pair.found.goToPush {"products":"TW LEDDim Smart Push"}');
  assert.equal(note('sg_push', '@GD1A2B'), 'pair.found.noPush pair.found.goToDimmer {"products":"LEDDim Smart"}');
  assert.equal(note('sg_push', '@SR1A2B'), 'pair.found.noPush pair.found.goToDin {"products":"LEDDim Smart DIN"}');
  assert.equal(note('sg_push', '@SF1A2B'), 'pair.found.noPush pair.found.notYet {"products":"LEDDim Smart Floor"}');
  assert.equal(note('sg_push', '@SK1A2B'), '', 'its own: no note');
});

test('pairing from sg_pill: a Push next to a Pill is not offered there; the Pill is', async () => {
  const { result } = await search(SGPillDriver, ['@SC1A2B', '@SK3C4D'], [node(0x0123, '@SC1A2B'), node(0x0124, '@SK3C4D')]);
  assert.deepEqual(result.devices.map((d) => d.data.id), ['@SC1A2B']);
  assert.deepEqual(result.found.map((f) => [f.name, f.state, f.driver]).sort(),
    [['@SC1A2B', 'add', 'sg_pill'], ['@SK3C4D', 'elsewhere', 'sg_push']]);
});

test('the texts for Push: in both languages, straight quotes, and no longer among those not supported', () => {
  const en = JSON.parse(read('locales/en.json'));
  const no = JSON.parse(read('locales/no.json'));
  assert.equal(en.pair.found.noPush, 'No LEDDim Smart Push found.');
  assert.equal(no.pair.found.noPush, 'Fant ingen LEDDim Smart Push.');
  assert.equal(en.pair.found.goToPush, 'Found __products__. Go back and select "LEDDim Smart Push" to add them.');
  assert.equal(no.pair.found.goToPush, 'Fant __products__. Gå tilbake og velg "LEDDim Smart Push" for å legge til.');
  for (const text of [en.pair.found.noPush, no.pair.found.noPush, en.pair.found.goToPush, no.pair.found.goToPush,
    en.settings.otherDevice.push, no.settings.otherDevice.push]) {
    assert.doesNotMatch(text, /[«»“”]/);
  }
  for (const text of [en.settings.otherDevice.other, no.settings.otherDevice.other, read('README.md')]) {
    assert.doesNotMatch(text, /such as Push|som Push/);
  }
});
