'use strict';

// HeatReg Smart 3.0 (type 3021, drivers/sg3_thermostat): its status (kind
// 0x2E, where the values sit is assumed), its commands 0x18 and 0x19 and
// their acknowledgement (assumed, not tried), the device that shows the
// status and sends a change once, its pairing beside the 3.0 dimmers, its
// manifest, the flow cards it shares with HeatReg Smart, and the account's
// lines on the settings page by product (Trond 2026-11-21). Made-up keys,
// ids and names.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('events');

const fake = require('./helpers/fake-homey');

fake.install();

const sg = require('../lib/sg3/protocol');
const { SG3_PRODUCTS, sg3CanBeBridge } = require('../lib/sgProducts');
const SG3Device = require('../lib/SG3Device');
const SG3ThermostatDevice = require('../lib/SG3ThermostatDevice');
const SG3ThermostatDriver = require('../drivers/sg3_thermostat/driver');
const SGSmartApp = require('../app');
const { SETTING, SgAccount, productGroups } = require('../lib/account');

const ROOT = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const HOME_KEY = '0a1b2c3d4e5f';
const NET_KEY = '0f1e2d3c4b5a69788796a5b4c3d2e1f0';
const APP_KEY = 'f0e1d2c3b4a5968778695a4b3c2d1e0f';

// A kind 0x2E message, 55 bytes after the opcode: the values where they are
// assumed to be, the rest made up.
function thermostatStatus({
  room = [0x15, 5], floor = [0x17, 2], setPoint = [0x16, 0], sensorBits = 2, heating = true, on = true,
} = {}) {
  const parameters = Buffer.alloc(55, 0x00);
  parameters[0] = 0x2e;
  parameters.set(room, 5);
  parameters.set(floor, 7);
  parameters.set(setPoint, 34);
  parameters[49] = sensorBits << 1;
  parameters[50] = (heating ? 2 : 0) | (on ? 4 : 0);
  return parameters;
}

test('the status of kind 0x2E: room, floor, set point, the sensor, heating and on, with the sign in bit 7 and the tenths in the second byte', () => {
  assert.equal(sg.KIND_THERMOSTAT_STATUS, 0x2e);
  assert.deepEqual(sg.parseThermostatStatus(thermostatStatus()), {
    room: 21.5, floor: 23.2, setPoint: 22, sensor: 'floor', heating: true, on: true,
  });
  const cold = sg.parseThermostatStatus(thermostatStatus({
    room: [0x80, 0], floor: [0x82, 3], setPoint: [0x05, 0], sensorBits: 1, heating: false, on: false,
  }));
  assert.deepEqual(cold, {
    room: 0, floor: -2.3, setPoint: 5, sensor: 'room', heating: false, on: false,
  });
  assert.equal(sg.parseThermostatStatus(thermostatStatus({ sensorBits: 3 })).sensor, 'roomFloor');
  assert.equal(sg.parseThermostatStatus(thermostatStatus({ sensorBits: 0 })).sensor, null);
  assert.equal(sg.parseThermostatStatus(thermostatStatus({ room: [0x15, 10] })).room, null, 'tenths above 9 do not read');
  assert.equal(sg.parseThermostatStatus(thermostatStatus().subarray(0, 50)), null, 'shorter than 51 bytes');
  assert.ok(sg.parseThermostatStatus(thermostatStatus().subarray(0, 51)));
  const other = thermostatStatus();
  other[0] = 0x2f;
  assert.equal(sg.parseThermostatStatus(other), null, 'another kind');
  assert.equal(sg.parseSgStatus(thermostatStatus()), null, 'never a dimmer\'s status');
});

// ------------------------------------------------------------ the commands (phase B)

const bytes = (buffer) => [...buffer].map((byte) => byte.toString(16).padStart(2, '0')).join(' ');
const IDS = { tid: 0x2a, seq: 0x00 };

test('0x18 on and off: the SG command opcode, then kind, TID, SEQ, the node (big-endian) and 1 or 0', () => {
  assert.equal(sg.KIND_THERMOSTAT_POWER, 0x18);
  assert.equal(bytes(sg.sgThermostatPower(0x5a01, true, IDS)), 'e0 e8 0e 18 2a 00 5a 01 01');
  assert.equal(bytes(sg.sgThermostatPower(0x5a01, false, IDS)), 'e0 e8 0e 18 2a 00 5a 01 00');
  assert.equal(bytes(sg.sgThermostatPower(0x0003, true, { tid: 0xff, seq: 0x07 })), 'e0 e8 0e 18 ff 07 00 03 01');
  for (const on of [1, 0, 'on', null, undefined]) assert.throws(() => sg.sgThermostatPower(0x5a01, on, IDS), /true or false/, String(on));
  assert.throws(() => sg.sgThermostatPower(0, true, IDS), /bad node address/);
});

test('0x19 the set point: whole degrees in byte 5 and tenths in byte 6, from 5 to 35 in steps of 0.5', () => {
  assert.equal(sg.KIND_THERMOSTAT_SET_POINT, 0x19);
  assert.equal(bytes(sg.sgThermostatSetPoint(0x5a01, 21.5, IDS)), 'e0 e8 0e 19 2a 00 5a 01 15 05');
  assert.equal(bytes(sg.sgThermostatSetPoint(0x5a01, 5, IDS)), 'e0 e8 0e 19 2a 00 5a 01 05 00');
  assert.equal(bytes(sg.sgThermostatSetPoint(0x5a01, 35, IDS)), 'e0 e8 0e 19 2a 00 5a 01 23 00');
  assert.equal(bytes(sg.sgThermostatSetPoint(0x5a01, 16, IDS)), 'e0 e8 0e 19 2a 00 5a 01 10 00');
  for (const degrees of [4.5, 35.5, 21.3, 21.25, -5, NaN, '21.5x', null]) {
    assert.throws(() => sg.sgThermostatSetPoint(0x5a01, degrees, IDS), /5 to 35 in steps of 0.5/, String(degrees));
  }
});

test('the commands would fit one unsegmented mesh message, and with segmented they go in two segments, as a dimmer\'s level', () => {
  assert.equal(sg.sgThermostatPower(0x5a01, true, IDS).length, 9);
  assert.equal(sg.sgThermostatSetPoint(0x5a01, 21.5, IDS).length, 10);
  const { encodeMeshMessage } = require('../lib/sigmesh/message');
  let seq = 100;
  const pdus = (accessPayload, segmented) => encodeMeshMessage({
    accessPayload, key: Buffer.from(APP_KEY, 'hex'), keyKind: 'application', src: 0x7f80, dst: 0x5a01, netKey: Buffer.from(NET_KEY, 'hex'),
    ivIndex: 0, ttl: 7, allocateSeq: () => seq++, segmented,
  });
  for (const payload of [sg.sgThermostatPower(0x5a01, true, IDS), sg.sgThermostatSetPoint(0x5a01, 21.5, IDS)]) {
    assert.equal(pdus(payload, false).length, 1);
    assert.equal(pdus(payload, true).length, 2);
  }
});

test('the acknowledgement of 0x18 and 0x19: the same kind, byte 1 is 1, the TID and SEQ of the command, an address, the values; anything else is none', () => {
  assert.deepEqual(sg.parseThermostatAck(Buffer.from([0x18, 0x01, 0x2a, 0x00, 0x7f, 0x80, 0x01])), {
    kind: 0x18, tid: 0x2a, seq: 0x00, address: 0x7f80, values: [1],
  });
  assert.deepEqual(sg.parseThermostatAck(Buffer.from([0x19, 0x01, 0x2a, 0x01, 0x7f, 0x80, 0x15, 0x05])), {
    kind: 0x19, tid: 0x2a, seq: 0x01, address: 0x7f80, values: [0x15, 0x05],
  });
  assert.equal(sg.parseThermostatAck(Buffer.from([0x19, 0x00, 0x2a, 0x00, 0x7f, 0x80, 0x15])), null, 'byte 1 not 1');
  assert.equal(sg.parseThermostatAck(Buffer.from([0x18, 0x01, 0x2a, 0x00, 0x7f, 0x80])), null, 'no value');
  assert.equal(sg.parseThermostatAck(Buffer.from([0x09, 0x01, 0x2a, 0x00, 0x7f, 0x80, 0x01, 0x32])), null, 'a dimmer\'s reply');
  assert.equal(sg.parseThermostatAck(thermostatStatus()), null, 'the status');
});

test('no command of kind 0x1D is built: the answer to it is not used', () => {
  const kinds = Object.entries(sg).filter(([name]) => name.startsWith('KIND_')).map(([, kind]) => kind);
  assert.ok(!kinds.includes(0x1d), kinds.join(','));
  assert.doesNotMatch(read('lib/sg3/protocol.js'), /0x1d|KIND_THERMOSTAT_(GET|READ|QUERY)/i);
});

test('HeatReg Smart 3.0 is type 3021 in its own driver, never a bridge; the 3.0 dimmers stay in LEDDim Smart 3.0', () => {
  assert.deepEqual(SG3_PRODUCTS[3021], { name: 'HeatReg Smart 3.0', driver: 'sg3_thermostat', bridge: false });
  assert.equal(sg3CanBeBridge(3021), false);
  assert.equal(SG3_PRODUCTS[3080].driver, 'sg3_dimmer');
});

// A thermostat device with a stand-in controller that records anything sent.
async function thermostat({ settings = {}, kept = {} } = {}) {
  const sent = [];
  // What setThermostat resolves with (answer(command)), or the error it
  // fails with; each call waits until the test lets it go (release).
  const waiting = [];
  const controller = Object.assign(new EventEmitter(), {
    start() { sent.push('start'); },
    setLevel: async (...args) => { sent.push(['setLevel', ...args]); },
    getStatus: async (...args) => { sent.push(['getStatus', ...args]); },
    setThermostat(node, command) {
      sent.push([node, command]);
      return new Promise((resolve, reject) => waiting.push(() => {
        const answer = controller.answer(command);
        if (answer instanceof Error) reject(answer);
        else resolve(answer);
      }));
    },
    answer: (command) => ({
      acked: true, segments: 2, ack: { values: command.power === undefined ? [Math.floor(command.setPoint), (command.setPoint * 10) % 10] : [command.power ? 1 : 0], ms: 400 },
    }),
  });
  // Lets the oldest send answer, and what follows it run.
  const release = async () => {
    waiting.shift()();
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
  };
  const app = { sg3: () => controller, sg3HomeKey: () => HOME_KEY };
  const homey = fake.fakeHomey(app, { __: (key) => key });
  const device = new SG3ThermostatDevice({
    homey, data: { id: `sig:${HOME_KEY}:5a01` }, store: { sg3Type: 3021 }, settings: { shown_temperature: 'auto', heating_cable_power: 0, ...settings },
  });
  const capabilities = new Set(SG3ThermostatDriver.LISTING.capabilities);
  device.hasCapability = (capability) => capabilities.has(capability);
  Object.assign(device._capabilities, kept);
  device.listened = {};
  device.registerCapabilityListener = (capability, listener) => { device.listened[capability] = listener; };
  await device.onInit();
  const status = (values) => controller.emit('thermostat', { node: 0x5a01, ...sg.parseThermostatStatus(thermostatStatus(values)) });
  const shown = () => Object.fromEntries([...capabilities].map((capability) => [capability, device.getCapabilityValue(capability)]));
  return {
    device, controller, sent, status, shown, homey, release,
  };
}

test('the device shows its status: the floor as the main temperature with the floor sensor, on and heat, heating; another node\'s status is not its', async () => {
  const { device, controller, sent, status, shown } = await thermostat({ settings: { heating_cable_power: 800 } });
  assert.equal(device.getSg3Address(), 0x5a01);
  assert.equal(device.sg3ListensOnly(), true);
  assert.equal(device.canBeSg3Bridge(), false);
  status();
  assert.deepEqual(shown(), {
    target_temperature: 22,
    measure_temperature: 23.2,
    'measure_temperature.floor': 23.2,
    'measure_temperature.room': 21.5,
    onoff: true,
    thermostat_mode: 'heat',
    sg_heating: true,
    measure_power: 800,
  });
  assert.ok(device.logs.includes('status: room 21.5, floor 23.2, set point 22.0, sensor floor, heating, on (first since start)'), device.logs.join('\n'));
  status();
  assert.equal(device.logs.filter((line) => line.startsWith('status: ')).length, 1, 'logged again only when it changes');
  controller.emit('thermostat', { node: 0x5a02, ...sg.parseThermostatStatus(thermostatStatus({ on: false })) });
  assert.equal(device.getCapabilityValue('onoff'), true);
  status({ heating: false, on: false });
  assert.deepEqual([device.getCapabilityValue('onoff'), device.getCapabilityValue('thermostat_mode'), device.getCapabilityValue('sg_heating'),
    device.getCapabilityValue('measure_power')], [false, 'off', false, 0]);
  assert.deepEqual(sent, [], 'nothing sent, not even a start');
});

test('the sensors: Room shows the room and no floor; Room with floor limit the room and the floor; none reported counts as Floor; the room at 0 is empty with the floor sensor', async () => {
  const { device, status } = await thermostat();
  status({ sensorBits: 1 });
  assert.deepEqual([device.getCapabilityValue('measure_temperature'), device.getCapabilityValue('measure_temperature.floor')], [21.5, null]);
  status({ sensorBits: 3 });
  assert.deepEqual([device.getCapabilityValue('measure_temperature'), device.getCapabilityValue('measure_temperature.floor')], [21.5, 23.2]);
  status({ sensorBits: 0 });
  assert.equal(device.getCapabilityValue('measure_temperature'), 23.2);
  status({ sensorBits: 2, room: [0, 0] });
  assert.equal(device.getCapabilityValue('measure_temperature.room'), null);
  status({ sensorBits: 1, room: [0, 0] });
  assert.equal(device.getCapabilityValue('measure_temperature.room'), 0);
});

test('"Displayed temperature" and "Heating cable power" count at once from the last status; a set point outside 5 to 35 is not shown', async () => {
  const { device, status } = await thermostat();
  status();
  await device.onSettings({ newSettings: { shown_temperature: 'room', heating_cable_power: 0 }, changedKeys: ['shown_temperature'] });
  assert.equal(device.getCapabilityValue('measure_temperature'), 21.5);
  await device.onSettings({ newSettings: { shown_temperature: 'room', heating_cable_power: 1200 }, changedKeys: ['heating_cable_power'] });
  assert.equal(device.getCapabilityValue('measure_power'), 1200);
  await device.onSettings({ newSettings: { shown_temperature: 'room', heating_cable_power: 0 }, changedKeys: ['heating_cable_power'] });
  assert.equal(device.getCapabilityValue('measure_power'), null);
  status({ setPoint: [40, 0] });
  assert.equal(device.getCapabilityValue('target_temperature'), 22, 'kept');
  assert.ok(device.logs.includes('set point 40.0 not shown: outside 5 to 35'));
});

test('after a start the values Homey kept stay until the first status', async () => {
  const kept = { target_temperature: 20.5, measure_temperature: 19, onoff: true };
  const { device, status } = await thermostat({ kept });
  await device.onSettings({ newSettings: { shown_temperature: 'room', heating_cable_power: 500 }, changedKeys: ['shown_temperature', 'heating_cable_power'] });
  assert.deepEqual([device.getCapabilityValue('target_temperature'), device.getCapabilityValue('measure_temperature'), device.getCapabilityValue('onoff')],
    [20.5, 19, true]);
  status();
  assert.equal(device.getCapabilityValue('target_temperature'), 22);
});

test('on and off from Homey: onoff and thermostat_mode (heat on, off off) send 0x18 once, shown at once, the acknowledged value kept', async () => {
  const { device, sent, status, release } = await thermostat();
  assert.deepEqual(Object.keys(device.listened).sort(), ['onoff', 'target_temperature', 'thermostat_mode']);
  status();
  await device.listened.onoff(false);
  assert.deepEqual(sent, [[0x5a01, { power: false }]]);
  assert.deepEqual([device.getCapabilityValue('onoff'), device.getCapabilityValue('thermostat_mode')], [false, 'off'], 'at once');
  await release();
  assert.deepEqual([device.getCapabilityValue('onoff'), device.getCapabilityValue('thermostat_mode')], [false, 'off']);
  assert.ok(device.logs.includes('off from Homey: acknowledged by the thermostat (0)'), device.logs.join('\n'));
  await device.listened.thermostat_mode('heat');
  await device.listened.thermostat_mode('off');
  assert.deepEqual(sent.slice(1), [[0x5a01, { power: true }], [0x5a01, { power: false }]]);
});

test('nothing is sent when its last status has the value and nothing of the kind is under way; while a send is, it is sent', async () => {
  const { device, sent, status, release } = await thermostat();
  status();
  await device.listened.onoff(true);
  assert.deepEqual(sent, []);
  assert.ok(device.logs.includes('on from Homey: the thermostat is on already, nothing sent'));
  await device.listened.onoff(false);
  await device.listened.onoff(true);
  assert.deepEqual(sent, [[0x5a01, { power: false }], [0x5a01, { power: true }]], 'the status says on, but off is under way');
  await release();
  await release();
  assert.equal(device.getCapabilityValue('onoff'), true);
});

test('without the thermostat\'s acknowledgement, or when not sent: a line, nothing sent again, and what it last reported is shown again', async () => {
  const { device, controller, sent, status, release } = await thermostat();
  status();
  controller.answer = () => ({ acked: true, segments: 2, ack: null });
  await device.listened.onoff(false);
  assert.equal(device.getCapabilityValue('onoff'), false);
  await release();
  assert.deepEqual(sent, [[0x5a01, { power: false }]], 'once');
  assert.deepEqual([device.getCapabilityValue('onoff'), device.getCapabilityValue('thermostat_mode')], [true, 'heat'], 'as it reported');
  assert.ok(device.logs.includes('off from Homey: no acknowledgement from the thermostat within 3 s, not sent again'));
  controller.answer = () => new Error('made-up: no link within 30 s');
  await device.listened.onoff(false);
  await release();
  assert.equal(device.getCapabilityValue('onoff'), true);
  assert.ok(device.logs.includes('off from Homey: not sent (made-up: no link within 30 s)'));
});

test('an older send\'s missing acknowledgement does not undo a newer change of the kind', async () => {
  const { device, controller, status, release } = await thermostat();
  status();
  controller.answer = (command) => (command.power === false ? { acked: true, segments: 2, ack: null } : { acked: true, segments: 2, ack: { values: [1], ms: 300 } });
  await device.listened.onoff(false);
  await device.listened.onoff(true);
  await release();
  assert.equal(device.getCapabilityValue('onoff'), true);
  await release();
  assert.equal(device.getCapabilityValue('onoff'), true);
});

test('the set point from Homey: stepped to 0.5, sent once it has rested 1.5 s, the last only; without an acknowledgement the one it last acknowledged or reported again', async () => {
  const { device, controller, sent, status, homey, release } = await thermostat();
  status();
  await device.listened.target_temperature(21.3);
  await device.listened.target_temperature(21.4);
  assert.deepEqual(sent, [], 'waits');
  homey.runMs(1500);
  assert.deepEqual(sent, [[0x5a01, { setPoint: 21.5 }]]);
  await release();
  assert.equal(device.getCapabilityValue('target_temperature'), 21.5);
  assert.ok(device.logs.includes('set point 21.5 from Homey: acknowledged by the thermostat (21 5)'), device.logs.join('\n'));
  await device.listened.target_temperature(21.5);
  homey.runMs(1500);
  assert.equal(sent.length, 1, 'it acknowledged 21.5, and nothing is under way');
  controller.answer = () => ({ acked: false, segments: 2, ack: null });
  await device.listened.target_temperature(40);
  homey.runMs(1500);
  assert.deepEqual(sent[1], [0x5a01, { setPoint: 35 }], 'at most 35');
  await release();
  assert.equal(device.getCapabilityValue('target_temperature'), 21.5, 'as it last acknowledged');
  status();
  assert.equal(device.getCapabilityValue('target_temperature'), 22, 'its next status counts');
});

test('before its first status since start, a change that does not get through shows again what Homey had kept', async () => {
  const { device, controller, release } = await thermostat({ kept: { onoff: false, thermostat_mode: 'off', target_temperature: 19.5 } });
  controller.answer = () => ({ acked: true, segments: 2, ack: null });
  await device.listened.onoff(true);
  await release();
  assert.deepEqual([device.getCapabilityValue('onoff'), device.getCapabilityValue('thermostat_mode')], [false, 'off']);
});

test('without a 3.0 network, or with another home\'s, it is unavailable with its own text', async () => {
  const homey = fake.fakeHomey({ sg3: () => null, sg3HomeKey: () => null });
  const device = new SG3ThermostatDevice({ homey, data: { id: `sig:${HOME_KEY}:5a01` }, store: { sg3Type: 3021 } });
  device.registerCapabilityListener = () => {};
  await device.onInit();
  assert.deepEqual([device.available, device.unavailableReason], [false, 'device.sg3NoNetwork']);
  const other = new SG3ThermostatDevice({
    homey: fake.fakeHomey({ sg3: () => new EventEmitter(), sg3HomeKey: () => 'ffeeddccbbaa' }), data: { id: `sig:${HOME_KEY}:5a01` }, store: { sg3Type: 3021 },
  });
  other.registerCapabilityListener = () => {};
  await other.onInit();
  assert.deepEqual([other.available, other.unavailableReason], [false, 'device.sg3ThermostatOtherHome']);
});

test('the app never gives the controller a thermostat to ask or set: only the dimmers are its devices', () => {
  const dimmer = {
    getSg3Address: () => 0x0003, getSg3HomeKey: () => HOME_KEY, canBeSg3Bridge: () => true,
  };
  const heatReg = {
    getSg3Address: () => 0x5a01, getSg3HomeKey: () => HOME_KEY, canBeSg3Bridge: () => false, sg3ListensOnly: () => true,
  };
  const app = Object.create(SGSmartApp.prototype);
  app.homey = fake.fakeHomey(app, { drivers: { getDrivers: () => ({ a: { getDevices: () => [dimmer, heatReg] } }) } });
  app.log = () => {};
  app.error = () => {};
  app.account = {
    sg3Network: () => ({
      homeKey: HOME_KEY, netKey: NET_KEY, appKey: APP_KEY, devices: [], addresses: [0x0003, 0x5a01], bridges: [0x0003],
    }),
  };
  const controller = app.sg3();
  assert.deepEqual(controller.deviceAddresses(), [0x0003]);
  assert.deepEqual(controller.homeyBridges(), [0x0003]);
  assert.equal(app._sg3Devices().length, 2);
  controller.stop().catch(() => {});
});

// The 3.0 network of the account as lib/account.js gives it.
const network = {
  homeKey: HOME_KEY,
  netKey: NET_KEY,
  appKey: APP_KEY,
  devices: [{ meshId: 0x0003, type: 3080, name: 'Made-up stue' }, { meshId: 0x5a01, type: 3021, name: 'Made-up bad' }, { meshId: 0x0004, type: 3081, name: null }],
};
const account = { fetched: () => true, sg3Network: () => network };

test('pairing: HeatReg Smart 3.0 lists the thermostats only, with its capabilities; LEDDim Smart 3.0 the dimmers only', () => {
  const thermostats = SG3Device.sg3PairingDevices(account, new Set(), [{ address: 0x0006, type: 3080 }], SG3ThermostatDriver.LISTING);
  assert.deepEqual(thermostats.devices, [{
    name: 'Made-up bad',
    data: { id: `sig:${HOME_KEY}:5a01` },
    capabilities: SG3ThermostatDriver.LISTING.capabilities,
    store: { sg3Type: 3021 },
  }]);
  assert.deepEqual([thermostats.inAccount, thermostats.inScan, thermostats.unknown], [1, 0, 0]);
  const dimmers = SG3Device.sg3PairingDevices(account, new Set(), [{ address: 0x0006, type: 3080 }]);
  assert.deepEqual(dimmers.devices.map((device) => [device.data.id.slice(-4), device.capabilities.join('+')]),
    [['0003', 'onoff+dim+measure_signal_strength+sg_connection'], ['0004', 'onoff+dim+measure_signal_strength+sg_connection'],
      ['0006', 'onoff+dim+measure_signal_strength+sg_connection']]);
  // One found in the scan by its type byte (0xB4, lib/sg3/advert.js) is
  // listed here, not with the dimmers.
  const scanned = [{ address: 0x5a02, type: 3021 }];
  assert.deepEqual(SG3Device.sg3PairingDevices(account, new Set(), scanned, SG3ThermostatDriver.LISTING).devices.map((device) => device.name),
    ['Made-up bad', 'HeatReg Smart 3.0 5A02']);
  assert.ok(!SG3Device.sg3PairingDevices(account, new Set(), scanned).devices.some((device) => device.data.id.endsWith('5a02')));
  const named = SG3Device.sg3PairingDevices({ fetched: () => true, sg3Network: () => ({ ...network, devices: [{ meshId: 0x5a01, type: 3021, name: null }] }) },
    new Set(), [], SG3ThermostatDriver.LISTING);
  assert.equal(named.devices[0].name, 'HeatReg Smart 3.0 5A01');
});

test('the driver: "HeatReg Smart 3.0", a thermostat with the capabilities it lists, the pairing of LEDDim Smart 3.0, no "Sensor", the images of HeatReg Smart', () => {
  const compose = JSON.parse(read('drivers/sg3_thermostat/driver.compose.json'));
  const heatReg = JSON.parse(read('drivers/sg_thermostat/driver.compose.json'));
  const dimmer = JSON.parse(read('drivers/sg3_dimmer/driver.compose.json'));
  assert.deepEqual(compose.name, { en: 'HeatReg Smart 3.0', no: 'HeatReg Smart 3.0' });
  assert.equal(compose.class, 'thermostat');
  assert.deepEqual(compose.capabilities, SG3ThermostatDriver.LISTING.capabilities);
  assert.deepEqual(compose.capabilitiesOptions.target_temperature, {
    min: 5, max: 35, step: 0.5, decimals: 1,
  });
  for (const id of Object.keys(compose.capabilitiesOptions)) assert.deepEqual(compose.capabilitiesOptions[id], heatReg.capabilitiesOptions[id], id);
  assert.deepEqual(compose.pair, dimmer.pair);
  assert.deepEqual(compose.images, heatReg.images);
  const settings = JSON.parse(read('drivers/sg3_thermostat/driver.settings.compose.json'));
  assert.deepEqual(settings.flatMap((group) => group.children.map((child) => child.id)), ['shown_temperature', 'heating_cable_power']);
  const heatRegSettings = JSON.parse(read('drivers/sg_thermostat/driver.settings.compose.json'))[1].children;
  for (const child of settings[0].children) assert.deepEqual(child, heatRegSettings.find((other) => other.id === child.id), child.id);
  assert.ok(!fs.existsSync(path.join(ROOT, 'drivers/sg3_thermostat/driver.flow.compose.json')), 'no flow cards of its own: the heating cards are shared');
  for (const file of ['assets/icon.svg', 'assets/images/small.png', 'assets/images/large.png', 'assets/images/xlarge.png', 'assets/guide/guide.png']) {
    assert.ok(fs.readFileSync(path.join(ROOT, 'drivers/sg3_thermostat', file)).equals(fs.readFileSync(path.join(ROOT, 'drivers/sg_thermostat', file))), file);
    assert.equal(fs.statSync(path.join(ROOT, 'drivers/sg3_thermostat', file)).mode & 0o777, 0o644, file);
  }
  const app = JSON.parse(read('app.json'));
  const built = app.drivers.find((driver) => driver.id === 'sg3_thermostat');
  assert.deepEqual(built.capabilities, compose.capabilities);
  assert.deepEqual(built.settings[0].children.map((child) => child.id), ['shown_temperature', 'heating_cable_power']);
});

test('the texts of HeatReg Smart 3.0, in both languages, with straight quotes', () => {
  const en = JSON.parse(read('locales/en.json'));
  const no = JSON.parse(read('locales/no.json'));
  for (const locale of [en, no]) {
    for (const text of [...Object.values(locale.pair.sg3Thermostat), ...Object.values(locale.pair.sg3ThermostatGuide),
      locale.device.sg3ThermostatOtherHome]) {
      assert.equal(typeof text, 'string');
      assert.doesNotMatch(text, /[«»“”]/);
    }
  }
  assert.deepEqual(Object.keys(en.pair.sg3ThermostatGuide), Object.keys(no.pair.sg3ThermostatGuide));
  // A change from Homey is sent now, so the text for refusing one is gone.
  assert.equal(en.device.sg3ThermostatReadOnly, undefined);
  assert.equal(no.device.sg3ThermostatReadOnly, undefined);
  const guide = read('drivers/sg3_thermostat/pair/guide.html');
  for (const key of Object.keys(en.pair.sg3ThermostatGuide)) assert.ok(guide.includes(`'pair.sg3ThermostatGuide.${key}'`), key);
  assert.ok(read('settings/index.html').includes(en.settings.otherDevice.sg3));
});

test('the heating cards are the app\'s, with the ids they had, for HeatReg Smart and HeatReg Smart 3.0; HeatReg Smart\'s other cards stay its own', () => {
  const app = JSON.parse(read('app.json'));
  const cards = Object.fromEntries(Object.values(app.flow).flat().map((card) => [card.id, card]));
  for (const id of ['sg_heating_true', 'sg_heating_false', 'sg_heating_is']) {
    assert.ok(cards[id], id);
    assert.deepEqual(cards[id].args, [{ type: 'device', name: 'device', filter: 'driver_id=sg_thermostat|sg3_thermostat' }], id);
  }
  assert.deepEqual([cards.sg_heating_true.title, cards.sg_heating_false.title, cards.sg_heating_is.title], [
    { en: 'Started heating', no: 'Begynte å varme' }, { en: 'Stopped heating', no: 'Sluttet å varme' },
    { en: '!{{Is|Is not}} heating', no: '!{{Varmer|Varmer ikke}}' },
  ]);
  assert.ok(app.flow.triggers.some((card) => card.id === 'sg_heating_true') && app.flow.conditions.some((card) => card.id === 'sg_heating_is'));
  const own = JSON.parse(read('drivers/sg_thermostat/driver.flow.compose.json'));
  assert.ok(!Object.values(own).flat().some((card) => card.id.startsWith('sg_heating')));
  assert.equal(cards.sg_window_open_true.args[0].filter, 'driver_id=sg_thermostat');
  assert.ok(read('drivers/sg_thermostat/driver.js').includes("flow.getConditionCard('sg_heating_is').registerRunListener"));
});

// ------------------------------------------------------------ the lines by product

const driverName = (id) => ({
  sg_mesh: 'LEDDim Smart', sg_pill: 'LEDDim Smart Pill', sg_plug: 'Smart Plug and Smart Socket', sg3_dimmer: 'LEDDim Smart 3.0', sg3_thermostat: 'HeatReg Smart 3.0',
}[id] || id);

test('the groups: those that can be added first, the most first, then not supported, recalled, other; the 3.0 devices plain where they cannot be added now', () => {
  const csr = productGroups([101, 1004, 101, 2003, 1031, 2, 9999, 1081].map((type) => ({ type })), { sg3: false, driverName });
  assert.deepEqual(csr, [
    { product: 'LEDDim Smart', count: 2, state: 'add', driver: 'LEDDim Smart', same: true },
    { product: 'LEDDim Smart 400 2-pole', count: 1, state: 'add', driver: 'LEDDim Smart', same: false },
    { product: 'LEDDim Smart Pill', count: 1, state: 'add', driver: 'LEDDim Smart Pill', same: true },
    { product: 'Smart Socket', count: 1, state: 'add', driver: 'Smart Plug and Smart Socket', same: false },
    { product: 'LEDDim Smart Floor', count: 1, state: 'notYet' },
    { product: 'Smart Plug', count: 1, state: 'recalled' },
    { product: null, count: 1, state: 'other' },
  ]);
  const sg3 = [3080, 3021, 3080, 3026].map((type) => ({ type }));
  assert.deepEqual(productGroups(sg3, { sg3: true, driverName }), [
    { product: 'LEDDim Smart 3.0', count: 2, state: 'add', driver: 'LEDDim Smart 3.0', same: true },
    { product: 'HeatReg Smart 3.0', count: 1, state: 'add', driver: 'HeatReg Smart 3.0', same: true },
    { product: null, count: 1, state: 'other' },
  ]);
  assert.deepEqual(productGroups(sg3, { sg3: true, inUse: false, driverName }).map((group) => group.state), ['plain', 'plain', 'otherPlain']);
});

// The settings page's own functions, run with its texts (as in
// test/account.test.js).
function summaryLines(language) {
  const page = read('settings/index.html');
  const texts = JSON.parse(read(`locales/${language}.json`));
  const Homey = {
    __: (key, tokens = {}) => {
      const text = key.split('.').reduce((at, part) => (at ? at[part] : undefined), texts);
      assert.equal(typeof text, 'string', key);
      return text.replace(/__([a-zA-Z]+)__/g, (whole, name) => (name in tokens ? String(tokens[name]) : whole));
    },
  };
  const slice = page.slice(page.indexOf('      const shownDevice = '), page.indexOf('      const showAccount = '));
  // eslint-disable-next-line no-new-func
  const homeLines = new Function('Homey', `${slice}\nreturn homeLines;`)(Homey);
  // The first line of each point: the devices, without the lines under them.
  return (home) => homeLines({
    quiet: [], unknown: [], sg3: 0, checked: false, total: 0, answering: 0, ...home,
  }).items.map((lines) => lines[0]);
}

// An app with a fetched SG account of one home of these devices (made up), in
// the user's language; the check after the fetch has asked the CSRmesh
// devices, and none answered.
async function fetchedSummary(language, devices) {
  const app = {
    logs: [],
    log(...args) { app.logs.push(args.join(' ')); },
    error() {},
    _devices: () => [],
    recentlyHeard: () => false,
    knownLocations: () => [],
  };
  app.csr = { nodes: new Map(), queueStatusAll: fake.queueAtOnce() };
  const values = new Map();
  const settings = {
    get: (k) => (values.has(k) ? values.get(k) : null), set: (k, v) => values.set(k, v), unset: (k) => values.delete(k),
  };
  app.homey = fake.fakeHomey(app, { settings, __: (key) => key, i18n: { getLanguage: () => language } });
  const home = {
    homeKey: HOME_KEY, passphrase: null, netKey: NET_KEY.toUpperCase(), appKey: APP_KEY, locationId: null, devices,
  };
  app.account = new SgAccount(app, { fetch: async () => ({ homes: [home], loggedOut: true }) });
  await app.account.login('tester@example.invalid', 'made-up pass 7');
  assert.ok(values.get(SETTING));
  return app.account.summary().homes[0];
}

// Two first generation dimmers, two 3.0 dimmers and a HeatReg Smart 3.0.
const trondsHome = [
  { meshId: 0x8001, type: 101, name: null },
  { meshId: 0x8002, type: 101, name: null },
  { meshId: 0x0003, type: 3080, name: null },
  { meshId: 0x0004, type: 3080, name: null },
  { meshId: 0x5a01, type: 3021, name: null },
];

test('the settings page by product: two 3.0 dimmers and a HeatReg Smart 3.0, "(can be added)" for both, in Norwegian and English', async () => {
  const no = await fetchedSummary('no', trondsHome);
  assert.deepEqual(summaryLines('no')(no), [
    'SG Smart: 2 LEDDim Smart (kan legges til). 0 av 2 svarer. Nettverkspassord: 1234.',
    'SG Smart 3.0: 2 LEDDim Smart 3.0 (kan legges til), 1 HeatReg Smart 3.0 (kan legges til).',
  ]);
  const en = await fetchedSummary('en', trondsHome);
  assert.deepEqual(summaryLines('en')(en), [
    'SG Smart: 2 LEDDim Smart (can be added). 0 of 2 respond. Network password: 1234.',
    'SG Smart 3.0: 2 LEDDim Smart 3.0 (can be added), 1 HeatReg Smart 3.0 (can be added).',
  ]);
});

test('the settings page by product: "added under" another driver, 2-pole in Norwegian, not supported, recalled and other devices; plain when it must be fetched again', async () => {
  const home = [
    ...trondsHome,
    { meshId: 0x0006, type: 3081, name: null },
    { meshId: 0x8003, type: 1004, name: null },
    { meshId: 0x8004, type: 2003, name: null },
    { meshId: 0x8005, type: 1031, name: null },
    { meshId: 0x8006, type: 1002, name: null },
    { meshId: 0x8007, type: 9999, name: null },
    { meshId: 0x8008, type: 2081, name: null },
  ];
  const no = await fetchedSummary('no', home);
  assert.deepEqual(summaryLines('no')(no), [
    'SG Smart: 2 LEDDim Smart (kan legges til), 1 LEDDim Smart 400 2-pol (legges til under LEDDim Smart), 1 LEDDim Smart Pill (kan legges til), '
      + '1 Smart Socket (legges til under Smart Plug og Smart Socket), 1 LEDDim Smart Floor (ikke støttet ennå), '
      + '1 Smart Plug (tilbakekalt, legges ikke til), 1 annen enhet (ikke støttet ennå). 0 av 2 svarer. Nettverkspassord: 1234.',
    'SG Smart 3.0: 2 LEDDim Smart 3.0 (kan legges til), 1 HeatReg Smart 3.0 (kan legges til), 1 LEDDim Smart 2-pol 3.0 (legges til under LEDDim Smart 3.0).',
  ]);
  const en = await fetchedSummary('en', home);
  assert.equal(summaryLines('en')(en)[1],
    'SG Smart 3.0: 2 LEDDim Smart 3.0 (can be added), 1 HeatReg Smart 3.0 (can be added), 1 LEDDim Smart 2-pole 3.0 (added under LEDDim Smart 3.0).');
  const plain = {
    number: 1, devices: 3, sg3: 3, sg3State: 'fetchAgain', sg3Groups: productGroups(trondsHome.slice(2), { sg3: true, inUse: false, driverName }),
  };
  assert.deepEqual(summaryLines('no')(plain), ['SG Smart 3.0: 2 LEDDim Smart 3.0, 1 HeatReg Smart 3.0. Trykk "Hent på nytt".']);
});

test('a Smart Switch the check did not ask is on the line of its own, not among the products', async () => {
  const summary = await fetchedSummary('no', [...trondsHome, { meshId: 0x8009, type: 11, name: null }]);
  assert.equal(summary.switches, 1);
  assert.deepEqual(summary.csrGroups.map((group) => group.product), ['LEDDim Smart']);
  assert.equal(summaryLines('no')(summary)[0], 'SG Smart: 2 LEDDim Smart (kan legges til). 0 av 2 svarer. Nettverkspassord: 1234.');
});

test('HeatReg Smart 3.0 never says "not supported yet": not in the groups, the texts or the page', async () => {
  const groups = productGroups([{ type: 3021 }], { sg3: true, driverName });
  assert.deepEqual(groups.map((group) => group.state), ['add']);
  const lines = summaryLines('no')(await fetchedSummary('no', [{ meshId: 0x5a01, type: 3021, name: null }])).join('\n');
  assert.doesNotMatch(lines, /HeatReg Smart 3\.0 \(ikke støttet ennå\)/);
  for (const file of ['locales/no.json', 'locales/en.json', 'settings/index.html']) {
    assert.doesNotMatch(read(file), /HeatReg Smart 3\.0 \((ikke støttet ennå|not supported yet)\)/, file);
  }
});
