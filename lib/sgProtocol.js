'use strict';

// The messages of SG's CSRmesh dimmers, as this app builds and reads them.
// Mostly a reference; gen1LevelData and parseGen1Status are what the dimmers
// use to talk.
// Everything here holds for any SG Gen1 installation. Nothing that belongs to
// one home goes in this file: passphrases, location ids, device ids and group
// numbers come from pairing, settings and the dimmers' own status.
//
// 16-bit addresses are written little-endian on the air: group 1 is 01 00,
// the device channel 0x8001 is 01 80.

// Destinations.
const ADDR_BROADCAST = 0x0000;
// Groups are addressed by their own mesh id, counted from 1.
const ADDR_GROUP_MIN = 0x0001;
// The app's own address. Also the destination of the status request.
const ADDR_APP = 0x8000;
// Every dimmer listens here; the payload carries the id of the one addressed.
const ADDR_DEVICES = 0x8001;

// Every SG payload starts with the home's location id, high byte first. It
// is set in each dimmer when it is paired, and differs from home to home. A
// dimmer ignores an A0 with another location id (tested 2026-10-27), so it is
// learned from each dimmer's status.

// Extension-model opcodes. A two-byte opcode goes on the air high byte first,
// straight after the destination, with the payload following.
//
// Sent from Homey to a group address, FF03 and FF0A had no effect on the
// first generation dimmers (tested 2026-09-18). Treat them as something Gen1
// dimmers do not act on.
//   FF03  level and on/off   <locHi locLo> <pwr> <level> <tidLo tidHi> <white>
//   FF0A  recall scene       <locHi locLo> <sceneNumber> <tid> 00
//   FFFF  status request     00, to ADDR_APP; assumed to make the dimmers
//                            report their status (not shown)
const OP_EXT_LEVEL = [0xff, 0x03];
const OP_EXT_SCENE = [0xff, 0x0a];
const OP_EXT_STATUS_REQUEST = [0xff, 0xff];

// The CSRmesh products after Gen1 (lib/SGCsrDevice.js) are assumed to act on
// these (not tried with a device yet):
//   FF03  level and on/off   as above; tid counts per device, white is 0 when
//                            not set
//   FF04  status request     <locHi locLo>, to the device
//   FF05  status             <locHi locLo> <pwr> <level> [number] [fw fw] [white flags]
//   FF10  name request       <locHi locLo>, to ADDR_BROADCAST: 00 00 for a
//                            device without a location id, the home's for
//                            the devices of that home
//   FF11  name               <locHi locLo> <six name characters> <resets> ...
//   FF50  fast status        <locHi locLo> <pwr> <level> <tidLo tidHi> <white> <flags>
// The sender of an FF11 is taken as the device's mesh id: the Bluetooth name
// does not carry it.
// The level counts only when pwr is on and it is 1..100.
const OP_EXT_STATUS_GET = [0xff, 0x04];
const OP_EXT_STATUS = [0xff, 0x05];
const OP_EXT_NAME_GET = [0xff, 0x10];
const OP_EXT_NAME = [0xff, 0x11];
const OP_EXT_FAST_STATUS = [0xff, 0x50];

// HeatReg Smart floor thermostats (@MT, @ST) are only read in this version
// (lib/CsrNetwork.js): asked, and their answers logged. Assumed formats, not
// tried with a thermostat yet. A temperature is two bytes, whole degrees and
// then tenths: 21.5 °C is 15 05.
//   FF04  status request     <locHi locLo>, to the thermostat; answer FF05
//   FF05  status             <locHi locLo> <state> <set point, 2> <fw fw> <more> <errors>
//                            state: bit 0 on, bit 2 window open, bit 5
//                            heating (the relay is in), bit 6 child lock,
//                            bit 7 clock set. more: bit 0 paused, bit 7
//                            clear when the schedule is on.
//   FF3C  request            <locHi locLo> <what>, to the thermostat: 00 the
//                            temperatures (FF3D), 01 the settings (FF5C), 02
//                            the preset temperatures (FF5D)
//   FF3D  temperatures       <locHi locLo> <room, 2> <floor, 2> <floor limit, 2>
//   FF5C  settings           <locHi locLo> <room offset> <floor offset> <b4> <b5> <b6>
//                            offset: bit 6 set for plus, bits 0..5 tenths.
//                            b6: bits 0..3 floor sensor type, bit 4
//                            adaptive heating, bit 5 open window detection.
//                            b4 and b5 are not known.
//   FF5D  presets            <locHi locLo> <three temperatures, 2 each>
// Nothing here sets a thermostat: no set point, no on/off, no settings.
const OP_EXT_THERMOSTAT_GET = [0xff, 0x3c];
const OP_EXT_THERMOSTAT_TEMPERATURES = [0xff, 0x3d];
const OP_EXT_THERMOSTAT_SETTINGS = [0xff, 0x5c];
const OP_EXT_THERMOSTAT_PRESETS = [0xff, 0x5d];
// What FF3C asks for.
const THERMOSTAT_ASK_TEMPERATURES = 0x00;
const THERMOSTAT_ASK_SETTINGS = 0x01;
const THERMOSTAT_ASK_PRESETS = 0x02;

// Data-model messages, all sent to ADDR_DEVICES inside an MCP block (0x73).
//   A0  level and on/off   A0 <tid> <locHi locLo> <idHi idLo> 00 00 01 <level>
//   CC  heartbeat          CC 40 <name bytes> <idHi idLo> 00 00 00 00
//   F0  set clock          F0 <tid> <yy> <mm> <weekday> <dd> <hh> <mm> <ss> 00
//                          (not sent by this app)
const MCP_DATA_BLOCK = 0x73;
const OP_DATA_LEVEL = 0xa0;
const OP_DATA_HEARTBEAT = 0xcc;
const OP_DATA_SET_TIME = 0xf0;

// Status from a dimmer, the only source of state. It comes by itself, about
// once a second while Homey listens:
//   73 F7 <locHi locLo> <idHi idLo> <four bytes> <level>
// Only the location id, the id and the level are used; the four bytes between
// are not checked.
const STATUS_PREFIX = [0x73, 0xf7];

// Levels are plain percent. 0 is off; a lit lamp reports 1..100.
const LEVEL_MIN = 1;
const LEVEL_MAX = 100;

// FF03 power byte. Off is 00 with level 0. 01 with level 0 is assumed to mean
// "on, at the level you had". A0 has no such byte: there, off is 01 with
// level 0.
const EXT_PWR_OFF = 0x00;
const EXT_PWR_ON = 0x01;

// CSRmesh group model. A device holds one group id per model and group
// index.
//   0F  set group id   0F <model> <index> <instance> <gidLo gidHi> <tid>
//   10  get group id   10 <model> <index> <tid>
//   11  answer to both
const OP_GROUP_SET = 0x0f;
const OP_GROUP_GET = 0x10;
const OP_GROUP_ANSWER = 0x11;

// CSRmesh model numbers that can carry a group id for a light.
const MODEL_POWER = 19;
const MODEL_LIGHT = 20;
const MODEL_EXTENSION = 28;

// Address as it goes on the air.
function addrBytes(addr) {
  return [addr & 0xff, (addr >> 8) & 0xff];
}

// The A0 for one dimmer, destination first, as makePacket takes it:
//   01 80 73 A0 <tid> <locHi locLo> <idHi idLo> 00 00 01 <level>
function gen1LevelData({ location, id, level, tid }) {
  return Buffer.from([
    ...addrBytes(ADDR_DEVICES), MCP_DATA_BLOCK,
    OP_DATA_LEVEL, tid & 0xff,
    (location >> 8) & 0xff, location & 0xff,
    (id >> 8) & 0xff, id & 0xff,
    0x00, 0x00, 0x01, level,
  ]);
}

// A decrypted payload (destination first) holding a dimmer's status, or null.
// Returns { location, id, level }; any location id is taken.
function parseGen1Status(plain) {
  if (!plain || plain.length < 13) return null;
  if (plain[2] !== STATUS_PREFIX[0] || plain[3] !== STATUS_PREFIX[1]) return null;
  const level = plain[12];
  if (level > LEVEL_MAX) return null;
  return { location: plain.readUInt16BE(4), id: plain.readUInt16BE(6), level };
}

const opcodeValue = (opcode) => (opcode[0] << 8) | opcode[1];
const locationBytes = (location) => [(location >> 8) & 0xff, location & 0xff];

// An extension-model message, destination first, as makePacket takes it.
function extData(dst, opcode, data) {
  return Buffer.from([...addrBytes(dst), ...opcode, ...data]);
}

// FF03 to one CSRmesh device. Off is pwr 00 with level 0. With `on`, the
// power byte follows it instead of the level: a device without dimming gets
// pwr 01 with level 0 for on.
function csrLevelData({ meshId, location, level, tid, white = 0, on }) {
  const pct = Math.max(0, Math.min(LEVEL_MAX, Math.round(level)));
  const power = typeof on === 'boolean' ? on : pct > 0;
  return extData(meshId, OP_EXT_LEVEL, [
    ...locationBytes(location), power ? EXT_PWR_ON : EXT_PWR_OFF, pct,
    tid & 0xff, (tid >> 8) & 0xff, white & 0xff,
  ]);
}

function csrStatusRequestData({ meshId, location }) {
  return extData(meshId, OP_EXT_STATUS_GET, locationBytes(location));
}

function csrNameRequestData(location = 0) {
  return extData(ADDR_BROADCAST, OP_EXT_NAME_GET, locationBytes(location));
}

// FFFF to ADDR_APP, once when a dimmer is added while the link is held.
// Assumed to make every first generation dimmer report its status; not shown,
// as a held link hears them anyway.
function statusRequestData() {
  return extData(ADDR_APP, OP_EXT_STATUS_REQUEST, [0x00]);
}

// A decrypted extension-model message: { dst, opcode, data }, or null for
// anything else (the data model, 0x73, among them).
function parseExt(plain) {
  if (!plain || plain.length < 4 || plain[2] !== 0xff) return null;
  return { dst: plain.readUInt16LE(0), opcode: plain.readUInt16BE(2), data: plain.subarray(4) };
}

// FF11: { location, name, resets }, with the name as @ and the six
// characters, or null.
function parseCsrName(data) {
  if (!data || data.length < 9) return null;
  const chars = data.subarray(2, 8);
  if (![...chars].every((c) => c >= 0x21 && c <= 0x7e)) return null;
  return { location: data.readUInt16BE(0), name: `@${chars.toString('latin1')}`, resets: data[8] };
}

// The level of a status: 0 when off, 1..100 when on, null when on with a level
// outside 1..100.
function csrLevel(pwr, level) {
  if (!pwr) return 0;
  return level >= LEVEL_MIN && level <= LEVEL_MAX ? level : null;
}

// FF05: { location, on, level, number, firmware, white }, or null. The parts
// in brackets above are null when the status is shorter.
function parseCsrStatus(data) {
  if (!data || data.length < 4) return null;
  return {
    location: data.readUInt16BE(0),
    on: data[2] !== 0,
    level: csrLevel(data[2], data[3]),
    number: data.length >= 5 ? data[4] : null,
    firmware: data.length >= 7 ? data.readUInt16BE(5) : null,
    white: data.length >= 9 ? data[7] : null,
  };
}

// FF50: { location, on, level, tid, white }, or null.
function parseCsrFastStatus(data) {
  if (!data || data.length < 4) return null;
  return {
    location: data.readUInt16BE(0),
    on: data[2] !== 0,
    level: csrLevel(data[2], data[3]),
    tid: data.length >= 6 ? data.readUInt16LE(4) : null,
    white: data.length >= 7 ? data[6] : null,
  };
}

// FF3C to one thermostat; what is THERMOSTAT_ASK_*.
function thermostatRequestData({ meshId, location, what }) {
  return extData(meshId, OP_EXT_THERMOSTAT_GET, [...locationBytes(location), what & 0xff]);
}

// A temperature from its two bytes, whole degrees and tenths.
const temperatureOf = (whole, tenths) => (whole * 10 + tenths) / 10;
// An offset from its byte: bit 6 set for plus, bits 0..5 tenths.
const offsetOf = (byte) => ((byte & 0x40) ? 1 : -1) * (byte & 0x3f) / 10;

// FF05 from a thermostat: { location, on, window, heating, childLock,
// clockSet, setPoint, firmware, paused, schedule, errors }, or null.
function parseThermostatStatus(data) {
  if (!data || data.length < 9) return null;
  return {
    location: data.readUInt16BE(0),
    on: (data[2] & 0x01) !== 0,
    window: (data[2] & 0x04) !== 0,
    heating: (data[2] & 0x20) !== 0,
    childLock: (data[2] & 0x40) !== 0,
    clockSet: (data[2] & 0x80) !== 0,
    setPoint: temperatureOf(data[3], data[4]),
    firmware: `${data[5]}.${data[6]}`,
    paused: (data[7] & 0x01) !== 0,
    schedule: (data[7] & 0x80) === 0,
    errors: data[8],
  };
}

// FF3D: { location, room, floor, floorLimit }, or null.
function parseThermostatTemperatures(data) {
  if (!data || data.length < 8) return null;
  return {
    location: data.readUInt16BE(0),
    room: temperatureOf(data[2], data[3]),
    floor: temperatureOf(data[4], data[5]),
    floorLimit: temperatureOf(data[6], data[7]),
  };
}

// FF5C: { location, roomOffset, floorOffset, b4, b5, sensorType, adaptive,
// windowDetection }, or null.
function parseThermostatSettings(data) {
  if (!data || data.length < 7) return null;
  return {
    location: data.readUInt16BE(0),
    roomOffset: offsetOf(data[2]),
    floorOffset: offsetOf(data[3]),
    b4: data[4],
    b5: data[5],
    sensorType: data[6] & 0x0f,
    adaptive: (data[6] & 0x10) !== 0,
    windowDetection: (data[6] & 0x20) !== 0,
  };
}

// FF5D: { location, presets: three temperatures }, or null.
function parseThermostatPresets(data) {
  if (!data || data.length < 8) return null;
  return {
    location: data.readUInt16BE(0),
    presets: [temperatureOf(data[2], data[3]), temperatureOf(data[4], data[5]), temperatureOf(data[6], data[7])],
  };
}

module.exports = {
  ADDR_APP,
  ADDR_BROADCAST,
  ADDR_DEVICES,
  ADDR_GROUP_MIN,
  EXT_PWR_OFF,
  EXT_PWR_ON,
  LEVEL_MAX,
  LEVEL_MIN,
  MCP_DATA_BLOCK,
  MODEL_EXTENSION,
  MODEL_LIGHT,
  MODEL_POWER,
  OP_DATA_HEARTBEAT,
  OP_DATA_LEVEL,
  OP_DATA_SET_TIME,
  OP_EXT_FAST_STATUS,
  OP_EXT_LEVEL,
  OP_EXT_NAME,
  OP_EXT_NAME_GET,
  OP_EXT_SCENE,
  OP_EXT_STATUS,
  OP_EXT_STATUS_GET,
  OP_EXT_STATUS_REQUEST,
  OP_EXT_THERMOSTAT_GET,
  OP_EXT_THERMOSTAT_PRESETS,
  OP_EXT_THERMOSTAT_SETTINGS,
  OP_EXT_THERMOSTAT_TEMPERATURES,
  OP_GROUP_ANSWER,
  OP_GROUP_GET,
  OP_GROUP_SET,
  STATUS_PREFIX,
  THERMOSTAT_ASK_PRESETS,
  THERMOSTAT_ASK_SETTINGS,
  THERMOSTAT_ASK_TEMPERATURES,
  addrBytes,
  csrLevelData,
  csrNameRequestData,
  csrStatusRequestData,
  extData,
  gen1LevelData,
  opcodeValue,
  parseCsrFastStatus,
  parseCsrName,
  parseCsrStatus,
  parseExt,
  parseGen1Status,
  parseThermostatPresets,
  parseThermostatSettings,
  parseThermostatStatus,
  parseThermostatTemperatures,
  statusRequestData,
  thermostatRequestData,
};
