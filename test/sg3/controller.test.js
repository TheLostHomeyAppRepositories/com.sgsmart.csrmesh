'use strict';

// The controller and the BLE layer against a fake Homey (settings, timers,
// ble) whose one proxy advertisement leads to a simulated SG node. The
// network comes as the SG account gives it. Keys are the specification's
// sample keys.

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  HOMEY_FIRST, HOMEY_LAST, OTHER_LINES, STATUS_BLOCK_MS, Sg3Controller,
} = require('../../lib/sg3/controller');
const { Sg3Bridge, advertAge, proxyCandidates } = require('../../lib/sg3/bridge');
const proxy = require('../../lib/sigmesh/proxy');
const { SimulatedSgNode } = require('./simulated-node');
const { advert, fakeHomey, NETWORK_ID } = require('./fake-homey');

const hex = (s) => Buffer.from(s, 'hex');
// What a command result says of the sending, without the times.
const sent = ({ acked, segments, writes }) => ({ acked, segments, writes });
const NET_KEY = '7dd7364cd842ad18c17c2b820c84c3d6';
const APP_KEY = '63964771734fbd76e3b40519d1d94a48';
const NETWORK = { netKey: NET_KEY, appKey: APP_KEY, addresses: [0x0003, 0x0005] };

function nodes() {
  const proxyNode = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const behind = new SimulatedSgNode({ netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x0005, level: 70, via: proxyNode, statusGroup: 0xffff });
  return { proxyNode, behind };
}

// The controller's clock (the status block and the TIDs): real time plus
// what a test moves it on by.
function clockFor() {
  const clock = { ahead: 0, now: () => Date.now() + clock.ahead };
  clock.pastBlock = () => { clock.ahead += STATUS_BLOCK_MS; };
  return clock;
}

function controllerFor(homey, extra = {}) {
  const logs = [];
  const clock = clockFor();
  const controller = new Sg3Controller({
    homey, network: NETWORK, deviceAddresses: () => homey.devices, log: (line) => logs.push(line), randomInt: () => 0, now: clock.now, ...extra,
  });
  return { controller, logs, clock };
}

function setUp(extra) {
  const { proxyNode, behind } = nodes();
  const homey = fakeHomey({ adverts: (calls) => [advert(proxyNode, { calls })] });
  return { homey, proxyNode, behind, ...controllerFor(homey, extra) };
}

// ------------------------------------------------------------ controller

test('keys that do not import: no 3.0 network, a line in the log, and nothing touches Bluetooth', async () => {
  const homey = fakeHomey();
  const logs = [];
  const controller = new Sg3Controller({ homey, network: { netKey: 'zz', appKey: APP_KEY }, log: (line) => logs.push(line) });
  assert.deepEqual(controller.status(), { configured: false });
  assert.ok(logs.includes('the account\'s 3.0 keys do not import (invalid_net_key): no 3.0 network'));
  await assert.rejects(controller.getStatus(0x0003), /not set up/);
  assert.equal(homey.calls.discover, 0);
  assert.deepEqual([...homey.store.keys()], []);
});

test('the network from the account: its Network ID, an address drawn and kept, and the IV Index from the beacon', async () => {
  const { homey, controller, logs } = setUp({ randomInt: (n) => n - 1 });
  assert.equal(controller.networkId, NETWORK_ID);
  assert.equal(controller.address, HOMEY_LAST);
  assert.equal(homey.store.get(`sg3Addr:${NETWORK_ID}`), HOMEY_LAST);
  assert.ok(logs.includes(`no address kept for this network on this Homey: drew 0x${HOMEY_LAST.toString(16)}`));
  assert.ok(logs.includes(`network …${NETWORK_ID.slice(-4)}: 2 node address(es) in the account, sending from 0x7ffe, `
    + 'IV Index unknown (from the beacon), commands to the node'), logs.join('\n'));
  await controller.getStatus(0x0003);
  assert.equal(homey.store.get(`sg3Iv:${NETWORK_ID}`), 0);
  await controller.stop();
  const again = controllerFor(homey, { randomInt: () => 0 });
  assert.equal(again.controller.address, HOMEY_LAST, 'the kept address, not a new draw');
  assert.equal(again.controller.storedIvIndex(), 0);
  await again.controller.stop();
});

test('the address is drawn from 0x7F80 to 0x7FFE, never one a node of the account has, and drawn again when a node has the kept one', async () => {
  const homey = fakeHomey();
  const drawn = [];
  const randomInt = (n) => { drawn.push(n); return 0; };
  const network = { ...NETWORK, addresses: [0x0003, HOMEY_FIRST] };
  const first = new Sg3Controller({ homey, network, randomInt });
  assert.equal(first.address, HOMEY_FIRST + 1);
  assert.deepEqual(drawn, [HOMEY_LAST - HOMEY_FIRST]);
  const logs = [];
  const moved = new Sg3Controller({ homey, network: { ...NETWORK, addresses: [HOMEY_FIRST + 1] }, randomInt, log: (line) => logs.push(line) });
  assert.equal(moved.address, HOMEY_FIRST);
  assert.ok(logs.includes('address 0x7f81 is taken now or out of range; drawing one'));
  homey.store.set(`sg3Addr:${NETWORK_ID}`, 0x7ff0 + 0x10);
  assert.equal(new Sg3Controller({ homey, network: NETWORK, randomInt: () => 5 }).address, HOMEY_FIRST + 5);
});

test('a restart on the same settings goes on above the old SEQs, so the node takes the next command', async () => {
  const first = setUp();
  assert.deepEqual(sent(await first.controller.setLevel(0x0003, 25)), { acked: true, segments: 2, writes: 4 });
  await first.controller.stop();
  const again = controllerFor(first.homey);
  // The TID and SEQ go on from the first run: with a new start the first
  // command may repeat the last TID and SEQ the node handled (as here, with
  // the same draws), and the node drops that repeat. The mesh SEQ is the test.
  again.controller.ids = first.controller.ids;
  assert.deepEqual(sent(await again.controller.setLevel(0x0003, 60)), { acked: true, segments: 2, writes: 4 });
  assert.equal(first.proxyNode.level, 60);
  await again.controller.stop();
});

test('the filter lets everything through, and a status to 0xFFFF from a node behind the proxy comes back', async () => {
  const { homey, controller, behind, proxyNode, logs, clock } = setUp();
  homey.devices.push(0x0005);
  assert.deepEqual(sent(await controller.setLevel(0x0005, 25)), { acked: true, segments: 2, writes: 4 });
  assert.equal(behind.level, 25);
  assert.equal(proxyNode.filter.type, proxy.FILTER_REJECT_LIST);
  assert.ok(logs.some((line) => /^filter ok via 0x0003, an empty reject list \(all let through\)/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /^0x0005 level 25 to 0x0005 on link #1: 2 segment\(s\), 4 write\(s\) in \d+\.\d s after \d+\.\d s in the queue, acked yes after/.test(line)),
    logs.join('\n'));
  clock.pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: false, level: 25 });
  assert.deepEqual(await heard, { node: 0x0005, kind: 0x03, on: false, level: 25 });
  assert.ok(logs.includes('status 0x0005 (by itself): off 25'));
  await controller.stop();
});

test('for 4 s after a command to a node, a status from it is held back and counted; then it is passed on', async () => {
  const { homey, controller, behind, clock, logs } = setUp();
  homey.devices.push(0x0005);
  const passed = [];
  controller.on('status', (status) => passed.push(status));
  await controller.setLevel(0x0005, 25);
  // The answer to the status request of the new link may come after the
  // command too, and is held back with it.
  await new Promise((resolve) => setTimeout(resolve, 20));
  const before = controller.counts.blocked;
  behind.localChange({ on: true, level: 26 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(passed, []);
  assert.equal(controller.counts.blocked, before + 1);
  clock.pastBlock();
  const heard = new Promise((resolve) => controller.once('status', resolve));
  behind.localChange({ on: true, level: 27 });
  assert.deepEqual(await heard, { node: 0x0005, kind: 0x03, on: true, level: 27 });
  controller.logSummary();
  assert.ok(logs.some((line) => line.includes(`(other nodes 0, held back ${before + 1})`)), logs.join('\n'));
  await controller.stop();
});

// The timer the controller sets to ask a node when its block ends (the
// only one between 3 and STATUS_BLOCK_MS), so a test can run it at once.
function catchAsks(homey) {
  const asks = [];
  const setTimeoutBefore = homey.setTimeout;
  homey.setTimeout = (fn, ms) => {
    const id = setTimeoutBefore(fn, ms);
    if (ms > 3000 && ms <= STATUS_BLOCK_MS) asks.push({ fn, id });
    return id;
  };
  // The last one set, run now instead of when it is due.
  asks.runLast = () => {
    const last = asks[asks.length - 1];
    homey.clearTimeout(last.id);
    last.fn();
  };
  return asks;
}

test('held: a status held back by the block makes the node be asked once when the block ends, and with detailed logging the held-back status is in the log', async () => {
  const { homey, controller, behind, clock, logs } = setUp({ detailed: () => true });
  homey.devices.push(0x0005);
  const asks = catchAsks(homey);
  await controller.setLevel(0x0005, 25);
  await pause(20);
  behind.localChange({ on: true, level: 26 });
  await pause(20);
  assert.ok(logs.includes('status 0x0005 held back (within the block): on 26'), logs.join('\n'));
  assert.ok(asks.length >= 1, 'a question set for when the block ends');
  clock.pastBlock();
  const answered = new Promise((resolve) => controller.once('status', resolve));
  asks.runLast();
  assert.deepEqual(await answered, { node: 0x0005, kind: 0x09, on: true, level: 26 });
  assert.ok(logs.includes('0x0005: a status came within the block, asking once'), logs.join('\n'));
  assert.equal(logs.filter((line) => line.endsWith('asking once')).length, 1);
  await controller.stop();
  assert.equal(controller.blockedAsk.size, 0, 'stop clears the questions');
});

test('not held, or after a newer command to the node, the node is not asked when the block ends; without detailed logging the held-back status is only counted', async () => {
  for (const newer of [false, true]) {
    const { homey, controller, behind, clock, logs } = setUp(newer ? {} : { held: () => ({ held: false, why: 'test' }) });
    homey.devices.push(0x0005);
    const asks = catchAsks(homey);
    await controller.setLevel(0x0005, 25);
    await pause(20);
    behind.localChange({ on: true, level: 26 });
    await pause(20);
    assert.ok(asks.length >= 1);
    const question = asks[asks.length - 1];
    if (newer) await controller.setLevel(0x0005, 40);
    clock.pastBlock();
    homey.clearTimeout(question.id);
    question.fn();
    await pause(20);
    assert.ok(!logs.some((line) => line.endsWith('asking once')), `${newer ? 'newer command' : 'not held'}: ${logs.join('\n')}`);
    assert.ok(!logs.some((line) => line.includes('held back (within the block)')));
    await controller.stop();
  }
});

test('the reserve: to 0xFFFF with the node in the payload, nothing to acknowledge, and the status request answered', async () => {
  const { controller, behind, logs, clock } = setUp({ sendTo: 'all' });
  assert.deepEqual(sent(await controller.setLevel(0x0005, 35)), { acked: undefined, segments: 2, writes: 4 });
  assert.equal(behind.level, 35);
  clock.pastBlock();
  assert.deepEqual(await controller.getStatus(0x0005), { on: true, level: 35 });
  assert.ok(logs.some((line) => /commands to 0xffff$/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /^0x0005 level 35 to 0xffff on link #1: 2 segment\(s\), 4 write\(s\) .*acked not asked/.test(line)), logs.join('\n'));
  await controller.stop();
  assert.throws(() => new Sg3Controller({ homey: fakeHomey(), network: NETWORK, sendTo: 'group' }), /sendTo must be node or all/);
});

test('when a link comes up, each 3.0 device in Homey is asked for its status once, and its answer is passed on', async () => {
  const { homey, controller, behind, proxyNode } = setUp();
  homey.devices.push(0x0003, 0x0005);
  behind.localChange({ on: false, level: 70 });
  const passed = [];
  controller.on('status', (status) => passed.push(status));
  controller.start();
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.deepEqual(passed.filter((status) => status.kind === 0x09).map(({ node, on, level }) => [node, on, level]),
    [[0x0003, true, 40], [0x0005, false, 70]]);
  assert.equal(proxyNode.events.filter((event) => event.startsWith('level')).length, 0, 'no command, only status requests');
  await controller.stop();
});

test('the log counts what comes in by destination and opcode: with detailed logging a first line for each, and the counts when the link closes', async () => {
  const { controller, behind, logs } = setUp({ detailed: () => true });
  await controller.setLevel(0x0005, 25);
  behind.localChange({ on: true, level: 30 });
  behind.localChange({ on: true, level: 31 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.stop();
  const address = `0x${controller.address.toString(16)}`;
  assert.ok(logs.includes(`in: first control 0x00 to ${address} (Homey)`), logs.join('\n'));
  assert.ok(logs.includes('in: first op f0e80e to 0xffff'), logs.join('\n'));
  assert.ok(logs.some((line) => line.startsWith('link #1 closed after ')
    && line.endsWith(`app stopping; in 3: to 0xffff 2, ${address} (Homey) 1; op f0e80e 2, control 0x00 1`)), logs.join('\n'));
});

test('without detailed logging: no "in: first" and no "proxy in:" lines, and the counts are still in the line when the link closes', async () => {
  const { controller, behind, logs } = setUp();
  await controller.setLevel(0x0005, 25);
  behind.localChange({ on: true, level: 30 });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await controller.stop();
  assert.ok(!logs.some((line) => line.startsWith('in: first') || line.startsWith('proxy in:')), logs.join('\n'));
  assert.ok(logs.some((line) => line.startsWith('link #1 closed after ') && line.includes('; in ')), logs.join('\n'));
});

// An SG message of 55 bytes after the opcode, of a kind not known here
// (0x31), the rest made up.
const otherKind = () => {
  const parameters = Buffer.alloc(55, 0x5a);
  parameters[0] = 0x31;
  return parameters;
};
const otherLines = (logs) => logs.filter((line) => line.startsWith('in: SG kind'));
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

test('an SG message to 0xFFFF that is not a dimmer\'s status: without detailed logging a line for the first of each sender and kind, with its length and never its content; not a status; counted', async () => {
  const { homey, controller, behind, proxyNode, logs } = setUp();
  const statuses = [];
  controller.on('status', (status) => statuses.push(status));
  await controller.setLevel(0x0005, 25);
  homey.devices.push(0x0003);
  behind.publish(0xffff, otherKind());
  behind.publish(0xffff, otherKind());
  proxyNode.publish(0xffff, Buffer.from([0x41, 0x01]));
  await settle();
  assert.deepEqual(otherLines(logs), [
    'in: SG kind 0x31, 55 byte(s), from 0x0005 to 0xffff',
    'in: SG kind 0x41, 2 byte(s), from 0x0003 (in Homey) to 0xffff',
  ]);
  assert.ok(!logs.some((line) => line.includes('5a5a')), 'never its content');
  assert.ok(statuses.every((status) => status.kind !== 0x31 && status.kind !== 0x41), 'not passed on as a status');
  controller.logSummary();
  assert.ok(logs.some((line) => line.includes('(other nodes 0, held back ') && line.includes('), thermostat 0, other SG 3, drops ')), logs.join('\n'));
  await controller.stop();
});

test('with detailed logging every one gets its line, also one without a kind; a dimmer\'s status gets none', async () => {
  const { controller, behind, logs } = setUp({ detailed: () => true });
  await controller.setLevel(0x0005, 25);
  behind.publish(0xffff, otherKind());
  behind.publish(0xffff, otherKind());
  behind.publish(0xffff, Buffer.alloc(0));
  behind.localChange({ on: true, level: 30 });
  await settle();
  assert.deepEqual(otherLines(logs), [
    'in: SG kind 0x31, 55 byte(s), from 0x0005 to 0xffff',
    'in: SG kind 0x31, 55 byte(s), from 0x0005 to 0xffff',
    'in: SG kind none, 0 byte(s), from 0x0005 to 0xffff',
  ]);
  await controller.stop();
});

// A HeatReg Smart 3.0's status, kind 0x2E: 55 bytes after the opcode, the
// values where they are assumed to be (lib/sg3/protocol.js), the rest made up.
const thermostatKind = () => {
  const parameters = Buffer.alloc(55, 0x00);
  parameters[0] = 0x2e;
  parameters.set([0x15, 5, 0x17, 2], 5);
  parameters.set([0x16, 0], 34);
  parameters[49] = 0x04;
  parameters[50] = 0x06;
  return parameters;
};

test('a HeatReg Smart 3.0\'s status to 0xFFFF goes out as "thermostat", in its segments, not as a status nor as another kind; with detailed logging a line; counted', async () => {
  const { controller, behind, logs } = setUp({ detailed: () => true });
  const statuses = [];
  const thermostats = [];
  controller.on('status', (status) => statuses.push(status));
  controller.on('thermostat', (status) => thermostats.push(status));
  await controller.setLevel(0x0005, 25);
  behind.publish(0xffff, thermostatKind());
  await settle();
  assert.deepEqual(thermostats, [{
    node: 0x0005, room: 21.5, floor: 23.2, setPoint: 22, eco: 0, comfort: 0, min: 0, protection: 0, lock: false, sensor: 'floor', minActive: false, heating: true, on: true, window: false,
  }]);
  assert.ok(statuses.every((status) => status.node !== 0x0005 || status.kind !== 0x2e));
  assert.deepEqual(otherLines(logs), []);
  assert.ok(logs.includes('thermostat 0x0005: room 21.5, floor 23.2, set point 22.0, sensor floor, heating, on, lock off'), logs.join('\n'));
  controller.logSummary();
  assert.ok(logs.some((line) => line.includes('), thermostat 1, other SG 0, drops ')), logs.join('\n'));
  await controller.stop();
});

test('without detailed logging a HeatReg Smart 3.0\'s status has no line here (the device logs what changes)', async () => {
  const { controller, behind, logs } = setUp();
  const thermostats = [];
  controller.on('thermostat', (status) => thermostats.push(status));
  await controller.setLevel(0x0005, 25);
  behind.publish(0xffff, thermostatKind());
  await settle();
  assert.equal(thermostats.length, 1);
  assert.ok(!logs.some((line) => line.startsWith('thermostat ')), logs.join('\n'));
  await controller.stop();
});

// ------------------------------------------------------------ HeatReg Smart 3.0 commands

// The node behind the proxy as a HeatReg Smart 3.0, acknowledging as told.
function thermostatSetUp(thermostatAck, extra = {}) {
  const set = setUp({ thermostatAckMs: 300, ...extra });
  set.behind.thermostatAck = thermostatAck;
  return set;
}
const ACK_LINE = /^0x0005 thermostat (on|off|set point \d+\.\d) to 0x0005 on link #1: 2 segment\(s\), \d+ write\(s\) in \d+\.\d s after \d+\.\d s in the queue, acked yes after \d+\.\d s; /;

test('HeatReg Smart 3.0 on, off and a set point: to the thermostat, in 2 segments it acknowledges, then its own acknowledgement with Homey\'s address, matched and logged', async () => {
  const { controller, behind, logs } = thermostatSetUp('yes');
  const on = await controller.setThermostat(0x0005, { power: true });
  assert.deepEqual([on.acked, on.segments, on.ack && on.ack.values], [true, 2, [1]]);
  assert.equal(behind.on, true);
  const off = await controller.setThermostat(0x0005, { power: false });
  assert.deepEqual(off.ack.values, [0]);
  assert.equal(behind.on, false);
  const setPoint = await controller.setThermostat(0x0005, { setPoint: 21.5 });
  assert.deepEqual([setPoint.acked, setPoint.segments, setPoint.ack.values], [true, 2, [21, 5]]);
  assert.equal(behind.setPoint, 21.5);
  assert.deepEqual(behind.received.filter((message) => message.kind === 0x18 || message.kind === 0x19),
    [{ kind: 0x18, segmented: true }, { kind: 0x18, segmented: true }, { kind: 0x19, segmented: true }], 'once each, in segments');
  const lines = logs.filter((line) => ACK_LINE.test(line));
  assert.equal(lines.length, 3, logs.join('\n'));
  assert.ok(lines.every((line) => /; acknowledged by the thermostat after \d+\.\d s$/.test(line)), lines.join('\n'));
  assert.ok(lines[2].startsWith('0x0005 thermostat set point 21.5 to 0x0005'));
  await controller.stop();
});

for (const [how, why] of [['none', 'none comes'], ['otherAddress', 'it names another address than Homey\'s'], ['otherTid', 'it has another TID']]) {
  test(`HeatReg Smart 3.0: no acknowledgement when ${why}; a line, and it is not sent again`, async () => {
    const { controller, behind, logs } = thermostatSetUp(how, { detailed: () => true });
    const result = await controller.setThermostat(0x0005, { setPoint: 21.5 });
    assert.deepEqual([result.acked, result.ack], [true, null]);
    await settle();
    assert.equal(behind.received.filter((message) => message.kind === 0x19).length, 1, 'sent once');
    assert.ok(logs.some((line) => ACK_LINE.test(line) && line.endsWith('; no acknowledgement from the thermostat within 0.3 s, not sent again')), logs.join('\n'));
    if (how !== 'none') {
      assert.ok(logs.some((line) => /^thermostat 0x0005 acknowledged kind 0x19 TID \d+ SEQ \d+ to 0x[0-9a-f]{4}( \(Homey\))?: 21 5$/.test(line)), 'heard, with detailed logging');
      assert.deepEqual(otherLines(logs), [], 'not another kind');
    }
    await controller.stop();
  });
}

test('HeatReg Smart 3.0 a preset: 0x08 in 2 segments, acknowledged; refused when the thermostat says so, not sent again', async () => {
  const { controller, behind, logs } = thermostatSetUp('yes');
  const eco = await controller.setThermostat(0x0005, { preset: 'eco' });
  assert.deepEqual([eco.acked, eco.segments, eco.ack.values, eco.ack.refused], [true, 2, [0], false]);
  assert.equal(behind.preset, 'eco');
  behind.thermostatAck = 'refused';
  const min = await controller.setThermostat(0x0005, { preset: 'min' });
  assert.deepEqual([min.ack.refused, behind.preset], [true, 'eco']);
  assert.equal(behind.received.filter((message) => message.kind === 0x08).length, 2, 'once each');
  assert.ok(logs.some((line) => line.startsWith('0x0005 thermostat preset eco to 0x0005 on link #1: 2 segment(s)') && /; acknowledged by the thermostat after \d+\.\d s$/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => line.startsWith('0x0005 thermostat preset min to 0x0005') && /; refused by the thermostat after \d+\.\d s, not sent again$/.test(line)), logs.join('\n'));
  await controller.stop();
});

// An advertisement of a node of this network with manufacturer data for
// 0x0EE8: its address at byte 8 (low byte first) and its type byte at 18.
function makerAdvert({ address = 0x0005, typeByte = 0xb4, rssi = -70, networkId = NETWORK_ID, uuid = 'made-up-node' } = {}) {
  const data = Buffer.alloc(29, 0x5a);
  data.writeUInt16LE(0x0ee8, 0);
  data.writeUInt16LE(address, 8);
  data[18] = typeByte;
  return {
    uuid,
    rssi,
    serviceData: [{ uuid: '00001828-0000-1000-8000-00805f9b34fb', data: Buffer.concat([Buffer.from([0x00]), Buffer.from(networkId, 'hex')]) }],
    manufacturerData: data,
  };
}

test('the nodes of this network in a scan, by address, type and signal, for HeatReg Smart 3.0\'s signal; another network\'s and a type not known here are not', () => {
  const { controller } = setUp();
  const seen = [];
  controller.on('advert', (advert) => seen.push(advert));
  controller.noteAdverts([
    makerAdvert(),
    makerAdvert({ address: 0x0003, typeByte: 0xa5, rssi: -58 }),
    makerAdvert({ address: 0x0006, typeByte: 0x77 }),
    makerAdvert({ networkId: '00112233445566ff' }),
    { uuid: 'no-data', rssi: -40 },
    null,
  ]);
  assert.deepEqual(seen, [
    { address: 0x0005, type: 3021, rssi: -70, source: 'scan' },
    { address: 0x0003, type: 3080, rssi: -58, source: 'scan' },
  ]);
  controller.noteAdverts([makerAdvert()], 'find');
  assert.equal(seen[2].source, 'find');
  controller.noteAdverts('not a list');
  assert.equal(seen.length, 3);
});

test('a scan of the controller without the app\'s queue is noted; with the queue, the app notes it (app.js, bleDiscover)', async () => {
  const { controller, homey } = setUp();
  const seen = [];
  controller.on('advert', (advert) => seen.push(advert));
  homey.ble.discover = async () => [makerAdvert()];
  await controller.discover();
  assert.equal(seen.length, 1);
  homey.app = { bleDiscover: async () => [makerAdvert()] };
  await controller.discover();
  assert.equal(seen.length, 1, 'not twice');
});

test('a dimmer\'s level is sent as before: only as many segments as it needs', async () => {
  const { controller, proxyNode } = setUp();
  const result = await controller.setLevel(0x0003, 25);
  assert.deepEqual(sent(result), { acked: true, segments: 2, writes: 4 });
  assert.deepEqual(proxyNode.received.filter((message) => message.kind === 0x07), [{ kind: 0x07, segmented: true }]);
  await controller.stop();
});

test('without detailed logging at most OTHER_LINES of these lines on a link', async () => {
  const { controller, behind, logs } = setUp();
  await controller.setLevel(0x0005, 25);
  for (let kind = 0x40; kind <= 0x40 + OTHER_LINES; kind += 1) behind.publish(0xffff, Buffer.from([kind, 0x00]));
  await settle();
  assert.equal(OTHER_LINES, 8);
  assert.deepEqual(otherLines(logs), Array.from({ length: OTHER_LINES }, (_, i) => `in: SG kind 0x${(0x40 + i).toString(16)}, 2 byte(s), from 0x0005 to 0xffff`));
  await controller.stop();
});

test('the scan goes through the app\'s queue of scans when the app has one', async () => {
  const { homey, controller } = setUp();
  const asked = [];
  homey.app = { bleDiscover: (...args) => { asked.push(args); return homey.ble.discover(...args); } };
  await controller.getStatus(0x0003);
  assert.deepEqual(asked, [[['1828']]]);
  await controller.stop();
});

test('held, after a remote hang-up with dimmers: a new link in 2 s', async () => {
  const { homey, controller, logs } = setUp();
  await controller.getStatus(0x0003);
  homey.devices.push(0x0003);
  homey.calls.peripherals[0].emit('disconnect');
  assert.equal(controller.status().connected, false);
  assert.ok(controller.reconnectTimer);
  assert.ok(logs.includes('new link in 2 s'), logs.join('\n'));
  await controller.stop();
  assert.equal(controller.reconnectTimer, null);
});

// ------------------------------------------------------------ held or not

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A controller whose held() the test sets (mode.held), with short times.
function modeSetUp({ held = false, ...extra } = {}) {
  const mode = { held };
  const made = setUp({ held: () => ({ held: mode.held, why: 'by the test' }), lingerMs: 60, pollMs: 80, ...extra });
  made.homey.devices.push(0x0003);
  return { ...made, mode };
}

test('not held: no link at start; a command opens it, a second shares it, and it is let go after the linger', async () => {
  const { controller, logs, proxyNode } = modeSetUp({ pollMs: 60000 });
  controller.start();
  await pause(20);
  assert.equal(controller.counts.links, 0);
  assert.ok(logs.includes('link: let go 0 s after the last command, status every 1 min (by the test)'), logs.join('\n'));
  await controller.setLevel(0x0003, 20);
  await pause(20);
  await controller.setLevel(0x0003, 30);
  assert.equal(proxyNode.level, 30);
  await pause(120);
  assert.equal(controller.counts.links, 1, 'both on one link');
  assert.ok(logs.some((line) => /^link #1 closed after \d+\.\d s: idle/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('not held: the status round opens a link, asks each 3.0 device, and lets it go after the answers', async () => {
  const { controller, logs } = modeSetUp();
  controller.start();
  await pause(150);
  assert.ok(logs.some((line) => /^0x0003 status: on 40 after/.test(line)), logs.join('\n'));
  assert.ok(logs.some((line) => /^link #1 closed after \d+\.\d s: status read/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('switched to held, the link comes up and stays; switched back, it is let go after the linger', async () => {
  const { controller, mode, logs } = modeSetUp({ pollMs: 60000 });
  controller.start();
  mode.held = true;
  controller.applyMode();
  await pause(60);
  assert.ok(controller.bridge.link, 'held: up');
  assert.ok(logs.includes('link: held (by the test)'));
  await pause(100);
  assert.ok(controller.bridge.link, 'held: still up after the linger');
  mode.held = false;
  controller.applyMode();
  await pause(120);
  assert.equal(controller.bridge.link, null, 'let go');
  await controller.stop();
});

test('a pairing search lets a held link go, and it comes back when the pause ends', async () => {
  const { controller, logs } = modeSetUp({ held: true });
  controller.start();
  await pause(60);
  assert.ok(controller.bridge.link);
  const end = await controller.pauseForScan('pairing scan');
  assert.equal(controller.bridge.link, null);
  assert.ok(logs.includes('pairing scan pause: link let go'), logs.join('\n'));
  await controller.setLevel(0x0003, 25);
  await pause(120);
  assert.equal(controller.bridge.link, null, 'a command meanwhile is let go as not held');
  end('list answered');
  await pause(60);
  assert.ok(controller.bridge.link, 'back');
  assert.ok(logs.includes('pairing scan pause over (list answered)'), logs.join('\n'));
  await controller.stop();
});

test('a command that finds no proxy waits for a link and goes out when it comes; a newer one to the node takes its place', async () => {
  const { proxyNode } = nodes();
  let visible = false;
  const homey = fakeHomey({ adverts: (calls) => (visible ? [advert(proxyNode, { calls })] : []) });
  homey.devices.push(0x0003);
  const { controller, logs } = controllerFor(homey, { held: () => ({ held: false, why: 'by the test' }), commandWaitMs: 2000 });
  const first = controller.setLevel(0x0003, 20);
  await pause(20);
  const second = controller.setLevel(0x0003, 30);
  assert.deepEqual(await first, { superseded: true });
  visible = true;
  await controller.session();
  const result = await second;
  assert.equal(result.acked, true);
  assert.equal(proxyNode.level, 30);
  assert.deepEqual(proxyNode.events.filter((event) => event.startsWith('level')), ['level 30'], 'the older is not sent');
  assert.ok(logs.some((line) => /^0x0003 level 30 waits up to 2 s for a link: no proxy node/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('a waiting command with no link within the time is not sent, and says so', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  homey.devices.push(0x0003);
  const { controller, logs } = controllerFor(homey, { held: () => ({ held: false, why: 'by the test' }), commandWaitMs: 50 });
  await assert.rejects(controller.setLevel(0x0003, 20), /no link within 0 s/);
  assert.ok(logs.some((line) => /^0x0003 level 20: no link within 0 s, not sent$/.test(line)), logs.join('\n'));
  await controller.stop();
});

test('after a failed connect, the next try is in 15 s', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  homey.devices.push(0x0003);
  const { controller, logs } = controllerFor(homey);
  controller.start();
  await pause(30);
  assert.ok(logs.includes('connect failed: no proxy node of this network in range'), logs.join('\n'));
  assert.ok(logs.includes('new link in 15 s'), logs.join('\n'));
  await controller.stop();
});

test('the proxy used last is reached with find, without a scan; when find fails, it scans', async () => {
  const first = setUp();
  await first.controller.getStatus(0x0003);
  await first.controller.stop();
  assert.equal(first.homey.store.get(`sg3Proxy:${NETWORK_ID}`), 'proxy-a');
  const scans = first.homey.calls.discover;
  const found = [];
  first.homey.ble.find = async (uuid) => { found.push(uuid); return advert(first.proxyNode, { calls: first.homey.calls }); };
  // The TID and SEQ go on, so the node does not take the request for a repeat.
  const again = controllerFor(first.homey);
  again.controller.ids = first.controller.ids;
  await again.controller.getStatus(0x0003);
  assert.deepEqual(found, ['proxy-a']);
  assert.equal(first.homey.calls.discover, scans, 'no scan');
  assert.ok(again.logs.some((line) => /^the proxy used last, …xy-a, without a scan/.test(line)), again.logs.join('\n'));
  await again.controller.stop();
  first.homey.ble.find = async () => { throw new Error('made-up: not known'); };
  const third = controllerFor(first.homey);
  third.controller.ids = first.controller.ids;
  await third.controller.getStatus(0x0003);
  assert.equal(first.homey.calls.discover, scans + 1, 'scanned');
  assert.ok(third.logs.some((line) => /did not answer \(made-up: not known\): scanning$/.test(line)), third.logs.join('\n'));
  await third.controller.stop();
});

test('a link names its node and the signal of its advertisement, and its log line says where the advertisement came from and how old it was', async () => {
  const first = setUp();
  const nodesSeen = [];
  first.controller.on('proxy', (node) => nodesSeen.push(node));
  await first.controller.getStatus(0x0003);
  assert.deepEqual(nodesSeen, [{ address: 0x0003, rssi: -60 }]);
  assert.deepEqual(first.controller.proxyNode, { address: 0x0003, rssi: -60 });
  assert.ok(first.logs.some((line) => /^link #1 …xy-a \(-60 dBm from a new scan, no age from Homey\): connect /.test(line)), first.logs.join('\n'));
  await first.controller.stop();
  // Without a scan, with the time Homey last saw it.
  first.homey.ble.find = async () => Object.assign(advert(first.proxyNode, { rssi: -71, calls: first.homey.calls }), { lastSeen: Date.now() - 2000 });
  const again = controllerFor(first.homey);
  again.controller.ids = first.controller.ids;
  await again.controller.getStatus(0x0003);
  assert.deepEqual(again.controller.proxyNode, { address: 0x0003, rssi: -71 });
  assert.ok(again.logs.some((line) => /^link #1 …xy-a \(-71 dBm from find without a scan, advert 2\.\d s old\): connect /.test(line)), again.logs.join('\n'));
  await again.controller.stop();
});

test('the age of an advertisement: from lastSeen in ms or as a date, none without it', () => {
  assert.equal(advertAge({ lastSeen: 1000 }, 3500), 2500);
  assert.equal(advertAge({ lastSeen: '1970-01-01T00:00:01.000Z' }, 3500), 2500);
  assert.equal(advertAge({ lastSeen: 5000 }, 3500), 0, 'a clock ahead is no age below 0');
  for (const advertisement of [{}, { lastSeen: null }, { lastSeen: 0 }, { lastSeen: 'not a date' }, null]) {
    assert.equal(advertAge(advertisement, 3500), null, JSON.stringify(advertisement));
  }
});

test('a proxy that may not be a bridge is let go, and the next one is used', async () => {
  const netKey = hex(NET_KEY);
  const appKey = hex(APP_KEY);
  const gateway = new SimulatedSgNode({ netKey, appKey, address: 0x0009, statusGroup: 0xffff });
  const dimmer = new SimulatedSgNode({ netKey, appKey, address: 0x0003, on: true, level: 40, statusGroup: 0xffff });
  const homey = fakeHomey({ adverts: (calls) => [advert(gateway, { uuid: 'gateway', rssi: -40, calls }), advert(dimmer, { uuid: 'dimmer', rssi: -70, calls })] });
  const { controller, logs } = controllerFor(homey, { network: { ...NETWORK, addresses: [0x0003, 0x0009], bridges: [0x0003] } });
  assert.deepEqual(await controller.getStatus(0x0003), { on: true, level: 40 });
  assert.deepEqual(homey.calls.connect, ['gateway', 'dimmer']);
  assert.ok(logs.some((line) => /proxy …eway \(-40 dBm\) failed: 0x0009 may not be a bridge$/.test(line)), logs.join('\n'));
  assert.equal(homey.store.get(`sg3Proxy:${NETWORK_ID}`), 'dimmer');
  await controller.stop();
});

// ------------------------------------------------------------ bridge

test('proxy candidates: our Network ID only, as list or object, strongest first', () => {
  const calls = { connect: [], order: [], peripherals: [] };
  const node = {};
  const near = advert(node, { uuid: 'near', rssi: -50, calls });
  const far = advert(node, { uuid: 'far', rssi: -80, calls });
  const other = advert(node, { uuid: 'other', networkId: '0011223344556677', calls });
  const identity = advert(node, { uuid: 'identity', type: 0x01, calls });
  const asObject = { uuid: 'object', rssi: -70, serviceData: { 1828: Buffer.concat([Buffer.from([0]), hex(NETWORK_ID)]) } };
  const picked = proxyCandidates([far, other, identity, asObject, near], hex(NETWORK_ID));
  assert.deepEqual(picked.map((a) => a.uuid), ['near', 'object', 'far']);
});

test('the scan line counts adverts with a Network ID and with a Node Identity, and those of this network', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({
    adverts: (calls) => [advert(proxyNode, { calls }), advert(proxyNode, { uuid: 'identity', type: 0x01, calls }),
      advert(proxyNode, { uuid: 'other', networkId: '0011223344556677', calls }), { uuid: 'bare', rssi: -90 }],
  });
  const { controller, logs } = controllerFor(homey);
  await controller.getStatus(0x0003);
  assert.ok(logs.some((line) => /^scan \d+\.\d s: 4 advert\(s\) with 1828, 3 with its service data \(2 Network ID, 1 Node Identity\), 1 of this network, best -60 dBm$/.test(line)),
    logs.join('\n'));
  await controller.stop();
});

test('the bridge tries the next proxy when one fails, and releases 2ADE before disconnecting', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({
    adverts: (calls) => [advert(proxyNode, { uuid: 'bad', rssi: -40, fail: true, calls }), advert(proxyNode, { uuid: 'good', calls })],
  });
  const { controller } = controllerFor(homey);
  await controller.getStatus(0x0003);
  assert.deepEqual(homey.calls.connect, ['bad', 'good']);
  await controller.stop();
  assert.deepEqual(homey.calls.order, ['unsubscribe', 'disconnect']);
});

test('no proxy of this network in range is an error, not a hang', async () => {
  const homey = fakeHomey({ adverts: () => [] });
  const { controller } = controllerFor(homey);
  await assert.rejects(controller.getStatus(0x0003), /no proxy node of this network/);
  await controller.stop();
});

test('a remote hang-up is not answered with an unsubscribe', async () => {
  const { proxyNode } = nodes();
  const calls = { connect: [], order: [], peripherals: [] };
  const bridge = new Sg3Bridge({
    ble: { discover: async () => [advert(proxyNode, { calls })] },
    networkId: hex(NETWORK_ID),
    createSession: (write) => new (require('../../lib/sigmesh/session').MeshSession)({
      netKey: hex(NET_KEY), appKey: hex(APP_KEY), address: 0x7fff,
      seqStore: new (require('../../lib/sigmesh/seq-store').SeqStore)({ get: () => null, set: () => {} }), write,
    }),
  });
  const reasons = [];
  bridge.on('disconnected', (reason) => reasons.push(reason));
  await bridge.ensureConnected();
  calls.peripherals[0].emit('disconnect');
  assert.deepEqual(reasons, ['remote hang-up']);
  assert.deepEqual(calls.order, []);
  assert.equal(bridge.session, null);
});

test('a link that fails before subscribing is closed without an unsubscribe', async () => {
  const { proxyNode } = nodes();
  const homey = fakeHomey({ adverts: (calls) => [advert(proxyNode, { noService: true, calls })] });
  const { controller } = controllerFor(homey);
  await assert.rejects(controller.getStatus(0x0003), /service 1828 not found/);
  assert.deepEqual(homey.calls.order, ['disconnect']);
  await controller.stop();
});

// ------------------------------------------------------------ a write that fails

// The node's writes throw while dead is true: a link Homey has lost without a
// 'disconnect'. A new link to the same node works again (dead set false).
function deadWrites(proxyNode) {
  const write = proxyNode.write.bind(proxyNode);
  const state = { dead: false };
  proxyNode.write = (frame) => {
    if (state.dead) throw new Error('Not connected');
    return write(frame);
  };
  return state;
}

test('held: a write that fails lets the link go; the command it was for is not sent again ("not sent"), and the next command goes on a new link', async () => {
  const {
    controller, logs, proxyNode, homey,
  } = modeSetUp({ held: true, pollMs: 60000 });
  const writes = deadWrites(proxyNode);
  controller.start();
  await pause(60);
  const first = controller.bridge.link;
  assert.ok(first, 'held: up');
  writes.dead = true;
  await assert.rejects(controller.setLevel(0x0003, 25), /Not connected/);
  assert.notEqual(controller.bridge.link, first, 'the dead link is let go');
  assert.ok(logs.some((line) => /^link #1 dropped after .*: write failed: Not connected/.test(line)), logs.join('\n'));
  assert.ok(logs.includes('new link in 2 s'), logs.join('\n'));
  writes.dead = false;
  const result = await controller.setLevel(0x0003, 30);
  assert.equal(result.acked, true);
  assert.equal(proxyNode.level, 30);
  assert.equal(homey.calls.connect.length, 2, 'one new link');
  assert.ok(logs.some((line) => /^0x0003 level 30 to 0x0003 on link #2:/.test(line)), logs.join('\n'));
  assert.equal(logs.filter((line) => /level 25 to/.test(line)).length, 0, 'the failed one is not sent again');
  await controller.stop();
});

test('not held: a write that fails lets the link go at once, not after the linger, and no new link comes by itself', async () => {
  const {
    controller, logs, proxyNode, homey,
  } = modeSetUp({ held: false, pollMs: 60000, lingerMs: 60000 });
  const writes = deadWrites(proxyNode);
  controller.start();
  await controller.setLevel(0x0003, 20);
  assert.ok(controller.bridge.link);
  writes.dead = true;
  await assert.rejects(controller.setLevel(0x0003, 25), /Not connected/);
  assert.equal(controller.bridge.link, null, 'let go');
  await pause(60);
  assert.equal(controller.bridge.link, null, 'no new link by itself');
  assert.ok(!logs.includes('new link in 2 s'), logs.join('\n'));
  writes.dead = false;
  await controller.setLevel(0x0003, 30);
  assert.equal(homey.calls.connect.length, 2);
  await controller.stop();
});

test('held: links whose writes fail right after they come up, again and again: the wait before the next link grows, 2, 5, 15 and then 60 s; '
  + 'a write that gets through starts it again at 2 s', async () => {
  const {
    controller, logs, proxyNode,
  } = modeSetUp({ held: true, pollMs: 60000 });
  const writes = deadWrites(proxyNode);
  // Each link is set up, then its writes fail (the status asked when it
  // comes up), while failing is true.
  let failing = true;
  controller.on('connection', (up) => {
    writes.dead = up && failing;
  });
  // The waits asked for are kept; the test does not wait them out.
  const asked = [];
  const connectSoon = controller.connectSoon.bind(controller);
  controller.connectSoon = (delay) => {
    if (delay > 0) asked.push(delay);
    return connectSoon(delay === undefined ? undefined : Math.min(delay, 1));
  };
  try {
    controller.start();
    for (let i = 0; i < 300 && asked.length < 5; i += 1) await pause(10);
    assert.deepEqual(asked.slice(0, 5), [2000, 5000, 15000, 60000, 60000], logs.join('\n'));
    assert.ok(logs.some((line) => /^link #\d+ dropped after .*: write failed: Not connected/.test(line)));
    failing = false;
    for (let i = 0; i < 300 && !(controller.bridge.link && controller.writeFails === 0); i += 1) await pause(10);
    assert.equal(controller.writeFails, 0, 'a write got through');
    const before = asked.length;
    writes.dead = true;
    await assert.rejects(controller.setLevel(0x0003, 25), /Not connected/);
    assert.equal(asked[before], 2000, 'after a write that got through: 2 s again');
    assert.equal(logs.filter((line) => /level 25 to/.test(line)).length, 0, 'the failed command is not sent again');
  } finally {
    failing = false;
    await controller.stop();
  }
});

test('held: links where the first part of a message gets through and the next part fails, again and again: the wait still grows, '
  + '2, 5, 15 and then 60 s (a part written is not a message written)', async () => {
  const { controller, logs, proxyNode } = modeSetUp({ held: true, pollMs: 60000 });
  // Each link is set up; then its first write gets through and the ones after
  // it fail. The first message on a link that is up is the status asked when
  // it comes up, in two parts.
  const write = proxyNode.write.bind(proxyNode);
  let left = Infinity;
  const through = [];
  proxyNode.write = (frame) => {
    if (left <= 0) throw new Error('Not connected');
    if (left !== Infinity) through.push(frame[0] >> 6);
    left -= 1;
    return write(frame);
  };
  controller.on('connection', (up) => {
    left = up ? 1 : Infinity;
  });
  const asked = [];
  const connectSoon = controller.connectSoon.bind(controller);
  controller.connectSoon = (delay) => {
    if (delay > 0) asked.push(delay);
    return connectSoon(delay === undefined ? undefined : Math.min(delay, 1));
  };
  try {
    controller.start();
    for (let i = 0; i < 300 && asked.length < 5; i += 1) await pause(10);
    assert.deepEqual(asked.slice(0, 5), [2000, 5000, 15000, 60000, 60000], logs.join('\n'));
    // On each link one write got through, the first part of a message (SAR 1).
    assert.ok(through.length >= 5);
    assert.ok(through.every((sar) => sar === 1), `parts through: ${through.join(', ')}`);
    assert.ok(logs.some((line) => /^link #\d+ dropped after .*: write failed: Not connected/.test(line)));
  } finally {
    left = Infinity;
    await controller.stop();
  }
});
