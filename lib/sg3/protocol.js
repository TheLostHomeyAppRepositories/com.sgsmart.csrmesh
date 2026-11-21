'use strict';

// SG Armaturen's vendor protocol for SG Smart 3.0 (Bluetooth SIG Mesh on a
// Telink stack, company ID 0x0EE8). The nodes have no Light Lightness server:
// power, level and status all go through one vendor opcode pair on vendor
// model 0x0EE8:0x0000, unacknowledged at the access layer.
//
//   command  E0 E8 0E | kind | TID | SEQ | NODE_HI | NODE_LO | ...
//   status   F0 E8 0E | kind | ...
//
// The target node is inside the payload, big-endian. A node drops a repeat
// of the TID it just handled, so every command needs a new one.
//
// After frekarlsen/ha-sg-smart-mesh, commit c00c73a: src/btmesh/sg_smart.py
// and the protocol description in that project (MIT, see
// ../sigmesh/LICENSE-MIT).

const { encodeAccessMessage, makeVendorOpcode } = require('../sigmesh/access');

const SG_COMPANY_ID = 0x0ee8;
const OP_SG_COMMAND = makeVendorOpcode(0x20, SG_COMPANY_ID); // E0 E8 0E
const OP_SG_STATUS = makeVendorOpcode(0x30, SG_COMPANY_ID); // F0 E8 0E

const KIND_POWER_LEVEL = 0x07;
const KIND_STATUS_REQUEST = 0x09;
const KIND_STATUS_RESPONSE = 0x09;
const KIND_STATUS_BROADCAST = 0x03;
// HeatReg Smart 3.0's status: sent by the thermostat itself to 0xFFFF, one
// message of 55 bytes after the opcode (seen 2026-11-21). Tried on a
// thermostat on 2026-11-21: the room and floor temperatures, the set point,
// the sensor, heating and on, and the presets in bytes 36 to 41; the rest is
// assumed (parseThermostatStatus).
const KIND_THERMOSTAT_STATUS = 0x2e;
// HeatReg Smart 3.0's commands, with the same header as a dimmer's (kind,
// TID, SEQ, the node): on or off in byte 5 (0x18), the set point in bytes 5
// (whole degrees) and 6 (tenths) (0x19). Tried on a thermostat on
// 2026-11-21: both taken, each acknowledged to 0xFFFF (parseThermostatAck)
// and followed by its status.
const KIND_THERMOSTAT_POWER = 0x18;
const KIND_THERMOSTAT_SET_POINT = 0x19;
// The preset (0x08): byte 5 is THERMOSTAT_PRESETS' number for it. The
// thermostat sets its set point to the preset's temperature too, and may
// refuse it (parseThermostatAck, refused). Assumed, not tried.
const KIND_THERMOSTAT_PRESET = 0x08;
const THERMOSTAT_PRESETS = Object.freeze({ eco: 0, comfort: 1, min: 2 });
// The set points HeatReg Smart 3.0 takes here: 5 to 35 in steps of 0.5.
const THERMOSTAT_SET_POINT_MIN = 5;
const THERMOSTAT_SET_POINT_MAX = 35;
const THERMOSTAT_SET_POINT_STEP = 0.5;

const LEVEL_OFF = 0;
const LEVEL_MAX = 100;
// On, at whatever level the node had before.
const LEVEL_LAST = 101;
// CCT, hue (2), white, saturation: FF is "unchanged". A plain dimmer ignores them.
const COLOUR_UNCHANGED = Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff]);

// Where power and level sit in the status parameters, per kind (verified by
// HA on a LEDDim Smart Pill 3.0, 2026-09-27):
//   0x09 reply      09 01 TID SEQ ADDR_HI ADDR_LO POWER LEVEL ...   (ADDR is whoever asked)
//   0x03 broadcast  03 TID SEQ FF FF POWER LEVEL ...                 (after a local change)
// The node keeps its level while off, so power has its own byte.
const STATUS_OFFSETS = {
  [KIND_STATUS_RESPONSE]: { power: 6, level: 7 },
  [KIND_STATUS_BROADCAST]: { power: 5, level: 6 },
};

function header(kind, node, tid, seq) {
  if (!Number.isInteger(node) || node < 1 || node > 0xffff) throw new Error(`bad node address ${node}`);
  return Buffer.from([kind, tid & 0xff, seq & 0xff, node >>> 8, node & 0xff]);
}

// Access payload (opcode included) that sets power and level on `node`.
function sgPowerLevelSet(node, level, { tid, seq }) {
  if (!Number.isInteger(level) || level < LEVEL_OFF || level > LEVEL_LAST) {
    throw new Error(`SG level must be 0-101, got ${level}`);
  }
  return encodeAccessMessage({
    opcode: OP_SG_COMMAND,
    parameters: Buffer.concat([header(KIND_POWER_LEVEL, node, tid, seq), Buffer.from([level]), COLOUR_UNCHANGED]),
  });
}

// Access payload (opcode included) that asks `node` for its status.
function sgStatusGet(node, { tid, seq }) {
  return encodeAccessMessage({ opcode: OP_SG_COMMAND, parameters: header(KIND_STATUS_REQUEST, node, tid, seq) });
}

// The parameters of an OP_SG_STATUS message: { kind, on, level }, or null for
// a kind that is not a status (button events, setting replies) or that does
// not parse.
function parseSgStatus(parameters) {
  if (!parameters || parameters.length < 1) return null;
  const kind = parameters[0];
  const offsets = STATUS_OFFSETS[kind];
  if (!offsets || parameters.length <= offsets.level) return null;
  const level = parameters[offsets.level];
  if (level > LEVEL_MAX) return null;
  return { kind, on: parameters[offsets.power] > 0 && level > 0, level };
}

// A temperature in two bytes: bit 7 of the first is the sign, its other bits
// whole degrees, the second tenths (0 to 9). null when the tenths are not
// 0 to 9; 0 with the sign is 0.
function temperatureAt(parameters, at) {
  const whole = parameters[at] & 0x7f;
  const tenths = parameters[at + 1];
  if (tenths > 9) return null;
  const value = Math.round((whole + tenths / 10) * 10) / 10;
  // The sign of 0.0 counts for nothing.
  return parameters[at] & 0x80 && value !== 0 ? -value : value;
}

// Access payload (opcode included) that turns HeatReg Smart 3.0 `node` on
// (true) or off (false).
function sgThermostatPower(node, on, { tid, seq }) {
  if (typeof on !== 'boolean') throw new Error(`thermostat power must be true or false, got ${on}`);
  return encodeAccessMessage({
    opcode: OP_SG_COMMAND,
    parameters: Buffer.concat([header(KIND_THERMOSTAT_POWER, node, tid, seq), Buffer.from([on ? 1 : 0])]),
  });
}

// Access payload (opcode included) that sets HeatReg Smart 3.0 `node` to a
// preset: 'eco', 'comfort' or 'min'.
function sgThermostatPreset(node, preset, { tid, seq }) {
  if (!Object.prototype.hasOwnProperty.call(THERMOSTAT_PRESETS, preset)) {
    throw new Error(`thermostat preset must be eco, comfort or min, got ${preset}`);
  }
  return encodeAccessMessage({
    opcode: OP_SG_COMMAND,
    parameters: Buffer.concat([header(KIND_THERMOSTAT_PRESET, node, tid, seq), Buffer.from([THERMOSTAT_PRESETS[preset]])]),
  });
}

// Access payload (opcode included) that sets the set point of HeatReg Smart
// 3.0 `node`: degrees from 5 to 35 in steps of 0.5, whole degrees in byte 5
// and tenths in byte 6.
function sgThermostatSetPoint(node, degrees, { tid, seq }) {
  const steps = Number(degrees) / THERMOSTAT_SET_POINT_STEP;
  if (!Number.isFinite(steps) || !Number.isInteger(steps) || degrees < THERMOSTAT_SET_POINT_MIN || degrees > THERMOSTAT_SET_POINT_MAX) {
    throw new Error(`thermostat set point must be ${THERMOSTAT_SET_POINT_MIN} to ${THERMOSTAT_SET_POINT_MAX} in steps of ${THERMOSTAT_SET_POINT_STEP}, got ${degrees}`);
  }
  const tenths = Math.round(degrees * 10);
  return encodeAccessMessage({
    opcode: OP_SG_COMMAND,
    parameters: Buffer.concat([header(KIND_THERMOSTAT_SET_POINT, node, tid, seq), Buffer.from([Math.floor(tenths / 10), tenths % 10])]),
  });
}

// The acknowledgement of a 0x18, 0x19 (tried) or 0x08 (assumed): the same kind,
// byte 1 is 1, bytes 2 and 3 the TID and SEQ of the command, bytes 4 and 5
// an address (big-endian), and from byte 6 the values. Only a 0x08 can be
// refused: byte 1 is 2 then. { kind, tid, seq, address, values, refused },
// or null for another kind, another byte 1, or one too short (a 0x18 or 0x19
// with no value; a 0x08 shorter than 6 bytes).
function parseThermostatAck(parameters) {
  if (!parameters || parameters.length < 6) return null;
  const kind = parameters[0];
  const preset = kind === KIND_THERMOSTAT_PRESET;
  if (!preset && kind !== KIND_THERMOSTAT_POWER && kind !== KIND_THERMOSTAT_SET_POINT) return null;
  if (!preset && (parameters[1] !== 1 || parameters.length < 7)) return null;
  if (preset && parameters[1] !== 1 && parameters[1] !== 2) return null;
  return {
    kind,
    tid: parameters[2],
    seq: parameters[3],
    address: parameters.readUInt16BE(4),
    values: [...parameters.subarray(6)],
    refused: parameters[1] === 2,
  };
}

// The sensor the thermostat uses, from bits 1 and 2 of byte 49: 'room',
// 'floor', 'roomFloor' (room with floor limit), or null for none given.
const THERMOSTAT_SENSORS = [null, 'room', 'floor', 'roomFloor'];

// The parameters of a kind 0x2E message (tried in part, see above): { room, floor,
// setPoint, eco, comfort, min, sensor, minActive, protection, heating, on,
// window }, the temperatures in degrees (null when they do not read), or
// null for another kind or a message shorter than 51 bytes (byte 50 is the
// last one read).
//   room        bytes 5 and 6      floor    bytes 7 and 8
//   setPoint    bytes 34 and 35    eco      bytes 36 and 37
//   comfort     bytes 38 and 39    min      bytes 40 and 41
//   protection  byte 47, read as HeatReg Smart's fault byte
//               (lib/SGThermostatDevice.js, faultsOf)
//   sensor      byte 49, bits 1 and 2
//   minActive   byte 49, bit 4: the preset min is in use
//   heating     byte 50, bit 1 (the relay)
//   on          byte 50, bit 2
//   window      byte 50, bit 4: the open window function has gone off
function parseThermostatStatus(parameters) {
  if (!parameters || parameters.length < 51 || parameters[0] !== KIND_THERMOSTAT_STATUS) return null;
  return {
    room: temperatureAt(parameters, 5),
    floor: temperatureAt(parameters, 7),
    setPoint: temperatureAt(parameters, 34),
    eco: temperatureAt(parameters, 36),
    comfort: temperatureAt(parameters, 38),
    min: temperatureAt(parameters, 40),
    protection: parameters[47],
    sensor: THERMOSTAT_SENSORS[(parameters[49] >> 1) & 3],
    minActive: ((parameters[49] >> 4) & 1) === 1,
    heating: ((parameters[50] >> 1) & 1) === 1,
    on: ((parameters[50] >> 2) & 1) === 1,
    window: ((parameters[50] >> 4) & 1) === 1,
  };
}

module.exports = {
  KIND_STATUS_RESPONSE,
  KIND_THERMOSTAT_POWER,
  KIND_THERMOSTAT_PRESET,
  KIND_THERMOSTAT_SET_POINT,
  KIND_THERMOSTAT_STATUS,
  LEVEL_LAST,
  LEVEL_MAX,
  LEVEL_OFF,
  OP_SG_COMMAND,
  OP_SG_STATUS,
  parseSgStatus,
  parseThermostatAck,
  parseThermostatStatus,
  sgPowerLevelSet,
  sgStatusGet,
  sgThermostatPower,
  sgThermostatPreset,
  sgThermostatSetPoint,
  THERMOSTAT_SET_POINT_MAX,
  THERMOSTAT_SET_POINT_MIN,
  THERMOSTAT_PRESETS,
  THERMOSTAT_SET_POINT_STEP,
};
