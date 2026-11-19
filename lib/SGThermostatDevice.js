'use strict';

const Homey = require('homey');
const { makePacket, resolveKey } = require('./csrmesh');
const {
  LOG_PER_SENDER, LOG_WINDOW_MS, NAME_LISTEN_MS, THERMOSTAT_LISTEN_MS,
} = require('./CsrNetwork');
const {
  OP_EXT_LEVEL, OP_EXT_THERMOSTAT_SET_POINT, isDeviceMeshId, opcodeValue, thermostatPowerData, thermostatPresetData,
  thermostatSetPointData,
} = require('./sgProtocol');
const { CHANGE_AFTER, learnLocation, otherLocationLine } = require('./location');
const { CommandTimer } = require('./commandTiming');
const { FAKE_ID_PREFIX } = require('./fakeDevices');
const {
  accountLocationFor, noHomeAtStart, noLocationKey, noteNoHome,
} = require('./homeLocation');

// HeatReg Smart (@MT, @ST), a floor heating thermostat with a room sensor and
// a floor sensor. The formats are assumed: no thermostat has been tried with
// Homey yet.
//
// Read: lib/CsrNetwork.js asks it and hands over its status (FF05), its
// temperatures (FF3D), its presets (FF5D) and its acknowledgement (FF08), and
// what another sends it: a set point (FF3E) or a preset (FF03), which is only
// shown here.
//
// Set: the set point is FF3E, a preset FF03 in the thermostat's own format,
// each sent up to SEND_TIMES times until the thermostat acknowledges it (see
// _sendRepeated), and on and off one FF42, once; only to its own mesh id, and
// nothing is sent when the thermostat has the value already. A change is
// refused before anything is sent, at once, or else taken at once: Homey
// does not wait for the sends (a link that is down can take a minute or
// more to give one up). When none of the messages of the newest change of
// its kind is written to the bridge, what the thermostat has is shown again
// and logged, with no error in Homey (_notWritten). Nothing is sent
// to set its settings, presets, floor limit or sensor. Byte 4 of FF3E is
// always 01; what it does in the thermostat is not known (assumed: nothing
// else, also not to its schedule).
//
// Its methods are named getCsrMeshId and getCsrLocationId, as in
// lib/SGCsrDevice.js, and it has no applyCsrStatus: a light's status never
// reaches it, and lib/SGCsrDevice.js never sends a light's FF03 to it.

const SET_POINT_MIN = 5;
const SET_POINT_MAX = 35;
const SET_POINT_STEP = 0.5;
// The wheel: the set point goes this long after it was last turned.
const SET_POINT_DEBOUNCE_MS = 1500;
// After a setting from here, or one heard from another: a status about what
// was set is not taken for this long, as it may be from before.
const QUIET_MS = 8000;
// One FF04 this long after the last setting from here, to read it back.
const READ_BACK_MS = 9000;
// After a setting from here, what another sends is not taken for this long.
const OTHERS_QUIET_MS = 4000;
// After a change refused here: how long until the device is shown again,
// with the value the thermostat has.
const SHOW_AGAIN_MS = 1000;
// The capabilities a change of each kind shows, and shows again when none of
// its messages is written (_notWritten).
const SHOWN = {
  setPoint: ['target_temperature', 'sg_heat_preset'],
  power: ['onoff', 'thermostat_mode'],
};
// A set point or preset: sent at most this many times, this long after the
// last one went out, until FF08 acknowledges it.
const SEND_TIMES = 3;
const SEND_GAP_MS = 1000;
const SET_POINT_OPCODE = opcodeValue(OP_EXT_THERMOSTAT_SET_POINT);
const PRESET_OPCODE = opcodeValue(OP_EXT_LEVEL);
// The tid: one up per setting, and 1 again when more than this many whole
// seconds have passed since the last one. A setting heard from another with
// a tid that is not newer within that time is dropped: the same one again,
// through another node, or our own coming back.
const TID_RESET_S = 10;
// FF05 byte 8 (assumed): bits 3..2 the floor sensor (01 a fault, 10 no
// reading when the floor reads 0), bits 5..4 the room sensor (01 or 10 a
// fault), bit 6 the thermostat, bit 7 the floor limit.
const floorSensorOf = (errors) => (errors >> 2) & 0x03;
const roomSensorFault = (errors) => [1, 2].includes((errors >> 4) & 0x03);
const DEVICE_FAULT_BIT = 0x40;
const FLOOR_LIMIT_BIT = 0x80;
// The faults shown, first first: the device, the floor sensor (FFF), the room
// sensor (E2), the floor sensor without a reading (E1), and a temperature of
// 0 or below (L0). Which count depends on the sensor setting.
const FAULT_ORDER = ['EEE', 'FFF', 'E2', 'E1', 'L0'];
const SENSOR_FAULTS = {
  floor: ['EEE', 'FFF', 'E1', 'L0'],
  room: ['EEE', 'E2', 'L0'],
  roomFloor: ['EEE', 'FFF', 'E2', 'E1', 'L0'],
};
// Those that are a problem (alarm_problem); L0 is only a warning.
const PROBLEMS = ['EEE', 'FFF', 'E2', 'E1'];
const PRESETS = ['comfort', 'eco', 'min'];
// "Sensor" (_sensor): Automatic, the default, or a sensor chosen.
const SENSOR_CHOICES = ['auto', 'floor', 'room', 'roomFloor'];
// In the store once "Sensor" Floor, the default of an earlier version, has
// been set to Automatic (_settingsAtStart).
const SENSOR_AUTO_MARK = 'sensorAutoOnce';
// "Displayed temperature" (_shownSensor).
const SHOWN_TEMPERATURES = ['auto', 'floor', 'room'];
// The thermostat modes it takes: heat (on) and off.
const MODES = ['heat', 'off'];

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const degrees = (value) => value.toFixed(1);

// The set point Homey can ask for: SET_POINT_MIN to SET_POINT_MAX, in steps
// of SET_POINT_STEP.
function setPointFor(value) {
  const stepped = Math.round(Number(value) / SET_POINT_STEP) * SET_POINT_STEP;
  return Math.max(SET_POINT_MIN, Math.min(SET_POINT_MAX, stepped));
}

// The faults FF05 byte 8 and the temperatures show for this sensor setting,
// in FAULT_ORDER.
function faultsOf(errors, temperatures, sensor) {
  const found = new Set();
  if (errors & DEVICE_FAULT_BIT) found.add('EEE');
  const floorBits = floorSensorOf(errors);
  if (floorBits === 1) found.add('FFF');
  if (floorBits === 2 && temperatures && temperatures.floor === 0) found.add('E1');
  if (roomSensorFault(errors)) found.add('E2');
  if (temperatures) {
    const floorLow = temperatures.floor <= 0;
    const roomLow = temperatures.room <= 0;
    const low = { floor: floorLow, room: roomLow, roomFloor: floorLow || roomLow };
    if (low[sensor]) found.add('L0');
  }
  const counted = SENSOR_FAULTS[sensor] || SENSOR_FAULTS.floor;
  return FAULT_ORDER.filter((code) => found.has(code) && counted.includes(code));
}

class SGThermostatDevice extends Homey.Device {
  async onInit() {
    // The temperatures Homey kept from before this start, and whether
    // measure_temperature.room was not there at it (_mainBeforeTemperatures):
    // read first, before anything waits, so a status that comes while the
    // start still waits has them.
    this._kept = this._keptTemperatures();
    this._noRoomBefore = !this.hasCapability('measure_temperature.room');
    // The time from a setting to its first status or acknowledgement, for the log.
    this._commandTimer = new CommandTimer(this);
    if (!this._net()) {
      this.log('fake device, but no fake network in this run: nothing is sent');
      await this.setUnavailable(this.homey.__('device.fakeLeftOver')).catch(() => {});
      return;
    }
    this._tid = 0;
    this._lastTidAt = 0;
    this._saidNoHome = noHomeAtStart(this);
    this._status = null;
    this._temperatures = null;
    this._presets = null;
    this._chosenPreset = null;
    this._asked = null;
    // What the thermostat has as far as is known: its last status taken, and
    // each setting written since (_known). The values before the first change
    // of a kind none of whose messages is written yet (_beforeChange).
    this._known = null;
    this._unwritten = { setPoint: null, power: null };
    this._changes = { setPoint: 0, power: 0 };
    // The sending of the newest change of each kind; its newest flag goes
    // when a newer change of that kind comes (_beforeChange).
    this._latest = { setPoint: null, power: null };
    this._quietUntil = 0;
    this._othersQuietUntil = 0;
    this._readBack = null;
    this._showAgainTimers = new Set();
    this._stopped = false;

    this.registerMultipleCapabilityListener(['target_temperature'], async ({ target_temperature: value }) => {
      await this._orShowAgain('target_temperature', () => this._setPoint(value));
    }, SET_POINT_DEBOUNCE_MS);
    this.registerCapabilityListener('onoff', async (value) => this._orShowAgain('onoff', () => this._power(value, 'onoff')));
    this.registerCapabilityListener('thermostat_mode', async (value) => this._orShowAgain('thermostat_mode', () => this._mode(value)));
    this.registerCapabilityListener('sg_heat_preset', async (value) => this._orShowAgain('sg_heat_preset', () => this._preset(value)));

    await this._settingsAtStart();
    await this._powerCapability();
    await this._roomCapability();
    await this._quickAction();
    await this.updateAvailability();
    this._net().csr.watchThermostat(this.getCsrMeshId(), { name: this._bluetoothName(), location: this.getCsrLocationId() });
    if (typeof this.homey.app.laterDevicesChanged === 'function') this.homey.app.laterDevicesChanged();
    const location = this.getCsrLocationId();
    this.log(`thermostat ready (${this.getStoreValue('prefix')}, mesh id ${hex4(this.getCsrMeshId())}, `
      + `loc ${location === null ? 'not known yet' : hex4(location)})`);
  }

  async onDeleted() {
    this._stopTimers();
    const net = this._net();
    if (net && net.csr && typeof net.csr.unwatchThermostat === 'function') net.csr.unwatchThermostat(this.getCsrMeshId());
    if (typeof this.homey.app.laterDevicesChanged === 'function') this.homey.app.laterDevicesChanged();
  }

  async onUninit() {
    this._stopTimers();
  }

  // Deleted or stopped, as in lib/SGCsrDevice.js: no read-back, no send
  // again and nothing shown again after this, also not from a send that the
  // bridge answers later.
  _stopTimers() {
    this._stopped = true;
    if (this._commandTimer) this._commandTimer.stop();
    if (this._readBack) this.homey.clearTimeout(this._readBack);
    this._readBack = null;
    if (this._repeat && this._repeat.timer) this.homey.clearTimeout(this._repeat.timer);
    this._repeat = null;
    for (const timer of this._showAgainTimers || []) this.homey.clearTimeout(timer);
    if (this._showAgainTimers) this._showAgainTimers.clear();
  }

  // Settings a thermostat may lack at start, when they have no valid value
  // (shown as empty in the Homey app): "Sensor" and "Displayed temperature"
  // are set to Automatic. Once for each thermostat (SENSOR_AUTO_MARK in its
  // store): "Sensor" Floor, the default of an earlier version, is set to
  // Automatic too; Room and Room with floor limit are kept, and Floor chosen
  // after that stays. A failure is logged, and tried again at the next
  // start: the mark is stored only once the settings are saved. It is
  // stored as well when "Sensor" is changed in the settings (onSettings), so
  // a sensor chosen is never set back, also when storing it failed here.
  async _settingsAtStart() {
    const settings = this.getSettings();
    const marked = this.getStoreValue(SENSOR_AUTO_MARK) === true;
    const earlierDefault = !marked && settings.sensor === 'floor';
    const changes = {};
    if (!SENSOR_CHOICES.includes(settings.sensor) || earlierDefault) changes.sensor = 'auto';
    if (!SHOWN_TEMPERATURES.includes(settings.shown_temperature)) changes.shown_temperature = 'auto';
    if (Object.keys(changes).length) {
      try {
        await this.setSettings(changes);
        this.log(`settings at start: ${Object.entries(changes).map(([key, value]) => `${key}=${value}`).join(', ')}`
          + `${earlierDefault ? ' (sensor floor, the default of an earlier version: once)' : ''}`);
      } catch (err) {
        this.error(`settings at start not saved: ${err.message || err}`);
        return;
      }
    }
    await this._storeSensorMark();
  }

  // SENSOR_AUTO_MARK in the store, when it is not there yet. A failure is
  // logged.
  async _storeSensorMark() {
    if (this.getStoreValue(SENSOR_AUTO_MARK) === true) return;
    await this.setStoreValue(SENSOR_AUTO_MARK, true).catch((err) => this.error(`${SENSOR_AUTO_MARK} not stored: ${err.message || err}`));
  }

  // As lib/SGCsrDevice.js: the app, or for a fake device its fake network.
  _net() {
    const { app } = this.homey;
    return typeof app.networkFor === 'function' ? app.networkFor(this) : app;
  }

  getCsrMeshId() {
    return Number(this.getStoreValue('meshId')) & 0xffff;
  }

  // The Bluetooth name it was added by, such as @MT1A2B.
  _bluetoothName() {
    return String((this.getData() || {}).id || '').replace(FAKE_ID_PREFIX, '');
  }

  // The device's own settings, or while they are the default the home's
  // passphrase from the SG account (lib/csrmesh.js, resolveKey).
  getNetworkKey() {
    const app = this.homey && this.homey.app;
    return resolveKey(this.getSettings(), app && typeof app.accountPassphrase === 'function' ? app.accountPassphrase(this) : null);
  }

  getCsrLocationId() {
    if (this._location && Number.isInteger(this._location.value)) return this._location.value;
    const stored = this.getStoreValue('locationId');
    return Number.isInteger(stored) ? stored : null;
  }

  // The location id a setting and its read-back go out with: its own, or, as
  // for the other devices (lib/SGCsrDevice.js, _accountLocation), its home's
  // in the SG account (lib/homeLocation.js), not when it said in an FF11 that
  // it is in no home (_saidNoHome). Not stored as its own.
  _commandLocation() {
    const own = this.getCsrLocationId();
    if (own !== null || this._saidNoHome) return own;
    return accountLocationFor(this.homey.app, this.getCsrMeshId(), this.getStoreValue('prefix'));
  }

  // The sensor the thermostat uses, as "Sensor" says. Automatic: the one its
  // status gives (FF05, lib/sgProtocol.js; assumed, not tried), and Floor
  // while none is given (0, or no status yet). Floor, Room and Room with
  // floor limit count whatever the status gives. It decides the faults, the
  // floor limit and Automatic under "Displayed temperature".
  _sensor(settings = this.getSettings()) {
    const choice = this._sensorChoice(settings);
    if (choice !== 'auto') return choice;
    const read = this._status && this._status.sensor;
    return SENSOR_FAULTS[read] ? read : 'floor';
  }

  _sensorChoice(settings = this.getSettings()) {
    return SENSOR_CHOICES.includes(settings.sensor) ? settings.sensor : 'auto';
  }

  // The sensor the status gives (null for none), logged at the first status
  // and when it changes, and when it differs from a sensor chosen under
  // "Sensor", which then counts.
  _noteSensor(read, settings = this.getSettings()) {
    const choice = this._sensorChoice(settings);
    if (this._sensorRead === undefined || read !== this._sensorRead) {
      const was = this._sensorRead === undefined ? '' : ` (was ${this._sensorRead || 'not given'})`;
      const used = choice === 'auto' ? 'floor is used (auto)' : `the setting is used (${choice})`;
      this.log(read ? `sensor from the status: ${read}${was}` : `sensor not given in the status: ${used}${was}`);
    }
    const differs = read && choice !== 'auto' && read !== choice ? `${read} ${choice}` : null;
    if (differs && differs !== this._sensorDiffers) {
      this.log(`sensor from the status: ${read}, the setting says ${choice}: the setting counts`);
    }
    this._sensorDiffers = differs;
    this._sensorRead = read;
  }

  // The sensor whose temperature is measure_temperature ("Displayed
  // temperature"): Automatic is the one the thermostat uses (_sensor), the
  // floor with Floor, otherwise the room.
  _shownSensor(settings = this.getSettings()) {
    const chosen = SHOWN_TEMPERATURES.includes(settings.shown_temperature) ? settings.shown_temperature : 'auto';
    if (chosen !== 'auto') return chosen;
    return this._sensor(settings) === 'floor' ? 'floor' : 'room';
  }

  // As the other devices (lib/location.js).
  _learnLocation(location) {
    const before = this.getCsrLocationId();
    const { state, outcome } = learnLocation(this._location || { value: before, other: null, count: 0 }, location);
    this._location = state;
    if (outcome === 'learned' || outcome === 'changed') {
      this.setStoreValue('locationId', state.value).catch((err) => this.error(`storing the location id failed: ${err.message || err}`));
      this.log(outcome === 'learned'
        ? `location id learned: ${hex4(state.value)}`
        : `location id changed: ${hex4(before)} to ${hex4(state.value)} (heard ${CHANGE_AFTER} times in a row)`);
      this.updateAvailability();
    }
    return outcome;
  }

  // Never unavailable. A warning while no status can be read at all
  // (password), while the location id is not known (lib/homeLocation.js: to
  // log in, or that it is not in the home fetched, or, in a build without
  // the account module, waiting for the first status), while nothing has
  // been heard from it for a while (the app's notHeard), or for a fault.
  async updateAvailability() {
    const net = this._net();
    if (!net) return;
    const unreadable = net.statusUnreadableText ? net.statusUnreadableText() : null;
    await this.setAvailable().catch(() => {});
    let warning = unreadable;
    if (!warning && this._commandLocation() === null) warning = this.homey.__(`thermostat.${noLocationKey(this.homey.app && this.homey.app.account)}`);
    if (!warning && typeof net.notHeard === 'function' && net.notHeard(this)) warning = this.homey.__('thermostat.notHeard');
    if (!warning && this._fault) warning = this.homey.__(`thermostat.fault.${this._fault}`);
    if (!warning && this._missing) warning = this.homey.__(`thermostat.shownMissing.${this._missing}`);
    if (warning === this._warningShown) return;
    this._warningShown = warning;
    if (warning) await this.setWarning(warning).catch(() => {});
    else await this.unsetWarning().catch(() => {});
  }

  // ---- setting the thermostat

  // Throws with the text Homey shows when it cannot be set: a fake device
  // without its network, a mesh id that is not one device's, or no location
  // id yet. Otherwise the network and the location id.
  _controlTarget(what) {
    const net = this._net();
    if (!net) throw new Error(this.homey.__('device.fakeLeftOver'));
    // Only to the thermostat's own mesh id: never 0, 0xFFFF or this app's own
    // addresses (a group cannot be told from a device by its number).
    if (!isDeviceMeshId(this.getCsrMeshId())) {
      this.log(`${what} refused: mesh id ${hex4(this.getCsrMeshId())} is not one device's, nothing sent`);
      throw new Error(this.homey.__('device.badMeshId'));
    }
    const location = this._commandLocation();
    if (location !== null && this.getCsrLocationId() === null) this.log(`${what}: location id ${hex4(location)} from the SG account`);
    if (location === null) {
      this.log(`${what} refused: location id not known yet, nothing sent`);
      net.csr.requestNames({ asked: true, listenMs: NAME_LISTEN_MS }).catch(() => {});
      throw new Error(this.homey.__('thermostat.waitingForStatus'));
    }
    return { net, location };
  }

  _nextTid() {
    const now = Date.now();
    this._tid = Math.floor((now - this._lastTidAt) / 1000) > TID_RESET_S ? 1 : (this._tid % 0xff) + 1;
    this._lastTidAt = now;
    return this._tid;
  }

  // One message, under the key of its queue: the set point (FF3E) and the
  // preset (FF03) share one, as both set the set point and the last one
  // chosen counts; on and off (FF42) has its own. A newer message replaces
  // one not yet sent in the same queue, never one in the other. A message
  // that did not go out is logged. Gives true when it was written, null
  // when a newer one replaced it before that (the newer one goes out), and
  // false when it was not written.
  async _send(net, data, what, queue, tid = this._tid) {
    const seq = net.nextSeq();
    this.log(`${what} to ${hex4(this.getCsrMeshId())} tid=${tid} seq=0x${seq.toString(16).padStart(6, '0')}`);
    const key = `thermostat:${this.getCsrMeshId()}:${queue}`;
    this._quiet();
    // Its answers after the message count as asked (lib/CsrNetwork.js).
    const meshId = this.getCsrMeshId();
    const asked = () => {
      if (net.csr && typeof net.csr.noteAsked === 'function') net.csr.noteAsked(meshId);
    };
    asked();
    const result = await net.bridge.send(makePacket(this.getNetworkKey(), seq, data), { key });
    if (result && result.ok) asked();
    if (this._commandTimer) this._commandTimer.sent(result);
    // Counted again from when it went out, which a slow link may delay.
    this._quiet();
    this._readBackSoon(net);
    if (!result || !result.ok) {
      const replaced = !!(result && result.superseded);
      this.log(`${what} not sent: ${replaced ? 'replaced by a newer one' : 'not delivered'}`);
      return replaced ? null : false;
    }
    return true;
  }

  // ---- a change none of whose messages is written

  // The capability values and the chosen preset before a change of this kind
  // (setPoint: the set point and the preset; power: on/off and the mode),
  // kept from the first one of them none of whose messages is written yet, so
  // a newer change before it goes out keeps them. The sending of the change
  // before is no longer the newest of its kind.
  _beforeChange(kind) {
    this._changes[kind] += 1;
    if (this._latest[kind]) this._latest[kind].newest = false;
    if (!this._unwritten[kind]) {
      this._unwritten[kind] = {
        values: Object.fromEntries(SHOWN[kind].map((id) => [id, this.hasCapability(id) ? this.getCapabilityValue(id) : null])),
        chosenPreset: this._chosenPreset,
      };
    }
    return this._unwritten[kind];
  }

  // A message of a change was written: what it sets is what the thermostat
  // has as far as is known. For the newest change of its kind, nothing is
  // kept to show again.
  _written(kind, fields, newest) {
    this._known = { ...(this._known || {}), ...fields };
    if (newest) this._unwritten[kind] = null;
  }

  // None of the messages of the newest change of this kind was written: the
  // thermostat has what it had, so that is shown again (its last status and
  // the settings written since, or without a status the values before the
  // change), and logged, with no error in Homey. SHOW_AGAIN_MS later, so it
  // comes after Homey has set the value chosen, and not when a newer change
  // of this kind came meanwhile. An older change never comes here, so what
  // is shown is never older than the last one chosen.
  _notWritten(kind, what) {
    if (this._stopped) return;
    const before = this._unwritten[kind];
    this._unwritten[kind] = null;
    const fields = kind === 'setPoint' ? ['setPoint', 'preset'] : ['on'];
    if (this._asked) {
      const asked = { ...this._asked };
      for (const field of fields) delete asked[field];
      this._asked = Object.keys(asked).length ? asked : null;
    }
    const known = this._known || {};
    if (kind === 'setPoint') {
      if (before) this._chosenPreset = before.chosenPreset;
      if (this._status && known.setPoint !== undefined) this._status = { ...this._status, setPoint: known.setPoint };
    } else if (this._status && known.on !== undefined) {
      this._status = { ...this._status, on: known.on };
    }
    const change = this._changes[kind];
    const timer = this.homey.setTimeout(() => {
      this._showAgainTimers.delete(timer);
      if (this._changes[kind] !== change) {
        this.log(`${what}: none of its messages was written to the bridge; not shown again, a newer change came`);
        return;
      }
      const shown = this._status ? {
        onoff: this._status.on,
        thermostat_mode: this._status.on ? 'heat' : 'off',
        target_temperature: this._status.setPoint,
        sg_heat_preset: this._presetOf(this._status),
      } : (before || { values: {} }).values;
      for (const id of SHOWN[kind]) if (shown[id] !== undefined) this._set(id, shown[id]);
      this.log(`${what}: none of its messages was written to the bridge; shown again as the thermostat has it `
        + `(${SHOWN[kind].map((id) => `${id}=${shown[id]}`).join(', ')}), no error in Homey`);
    }, SHOW_AGAIN_MS);
    this._showAgainTimers.add(timer);
  }

  // A set point (FF3E) or a preset (FF03): sent up to SEND_TIMES times, each
  // SEND_GAP_MS after the last one went out, the same message with the same
  // tid each time, and no more once the thermostat acknowledges it with FF08
  // (_acknowledged). A newer set point or preset ends the sends left of this
  // one. Each send is logged, and so is how it ended. Assumed: the
  // thermostat acknowledges what it took, and takes the same tid once (not
  // tried with a thermostat). An FF08 that does not come is no error (the
  // read-back shows what it has). fields is what it sets, for _written; when
  // none of the sends is written, _notWritten shows what the thermostat has,
  // unless a newer set point or preset came. Whether it is the newest is its
  // own flag (newest), not whether it is still sending: an FF08 that comes
  // before the bridge has answered for the send ends the sends, and the
  // change is still the newest.
  async _sendRepeated(net, data, what, opcode, fields) {
    this._endRepeats('replaced by a newer setting');
    const run = {
      what, opcode, tid: this._tid, sent: 0, timer: null, written: false, newest: true,
    };
    this._repeat = run;
    this._latest.setPoint = run;
    // What _send gave for this one, or null when none was sent.
    const next = async () => {
      run.timer = null;
      if (this._repeat !== run) return null;
      if (run.sent === SEND_TIMES) {
        this._repeat = null;
        this.log(`${what}: no acknowledgement (FF08) after ${SEND_TIMES} of ${SEND_TIMES}`);
        if (!run.written && run.newest) this._notWritten('setPoint', what);
        return null;
      }
      run.sent += 1;
      const sent = await this._send(net, data, `${what} (${run.sent} of ${SEND_TIMES})`, 'set-point', run.tid);
      if (sent === true && !run.written) {
        run.written = true;
        this._written('setPoint', fields, run.newest);
      }
      if (this._repeat !== run) return sent;
      run.timer = this.homey.setTimeout(() => {
        next().catch((err) => this.error(`${what}: sending again failed: ${err.message || err}`));
      }, SEND_GAP_MS);
      return sent;
    };
    await next();
  }

  // Ends the sends left of the set point or preset, if any, with why.
  _endRepeats(why) {
    const run = this._repeat;
    if (!run) return;
    if (run.timer) this.homey.clearTimeout(run.timer);
    this._repeat = null;
    if (run.sent < SEND_TIMES) this.log(`${run.what}: the last ${SEND_TIMES - run.sent} of ${SEND_TIMES} not sent, ${why}`);
  }

  // FF08 from this thermostat: the set point or preset sent from here is
  // taken, so the sends left of it end.
  _acknowledged(ack) {
    const run = this._repeat;
    const opcode = ack.opcode.toString(16).toUpperCase();
    if (!run || run.opcode !== ack.opcode) {
      this.log(`FF08 for ${opcode}: nothing from here waits for it`);
      return;
    }
    if (run.timer) this.homey.clearTimeout(run.timer);
    this._repeat = null;
    this.log(`${run.what}: acknowledged (FF08) after ${run.sent} of ${SEND_TIMES}, no more sent`);
  }

  // Around a setting: QUIET_MS without taking a status about it, and
  // OTHERS_QUIET_MS without taking another's.
  _quiet() {
    const now = Date.now();
    this._quietUntil = now + QUIET_MS;
    this._othersQuietUntil = now + OTHERS_QUIET_MS;
  }

  // One FF04 READ_BACK_MS after the last setting; none once stopped.
  _readBackSoon(net) {
    if (this._stopped) return;
    if (this._readBack) this.homey.clearTimeout(this._readBack);
    this._readBack = this.homey.setTimeout(() => {
      this._readBack = null;
      const location = this._commandLocation();
      if (location !== null) net.csr.requestStatus(this.getCsrMeshId(), location, THERMOSTAT_LISTEN_MS).catch(() => {});
    }, READ_BACK_MS);
  }

  async _setPoint(value) {
    const setPoint = setPointFor(value);
    if (!Number.isFinite(setPoint)) throw new Error(`not a temperature: ${value}`);
    const what = `set point ${degrees(setPoint)}`;
    const { net, location } = this._controlTarget(what);
    if (this._status && this._status.setPoint === setPoint) {
      this.log(`${what}: the thermostat has it already, nothing sent`);
      return;
    }
    this._beforeChange('setPoint');
    this._asked = { ...this._asked, setPoint };
    this._expect({ setPoint });
    const data = thermostatSetPointData({ meshId: this.getCsrMeshId(), location, temperature: setPoint, tid: this._nextTid() });
    this._inBackground(this._sendRepeated(net, data, `FF3E ${what}`, SET_POINT_OPCODE, { setPoint }), what);
  }

  // A change's sends go on after Homey has its answer; an error in them is
  // logged.
  _inBackground(sending, what) {
    sending.catch((err) => this.error(`${what}: sending failed: ${err.message || err}`));
  }

  // A thermostat mode: heat is on and off is off; any other is refused, and
  // nothing is sent.
  async _mode(value) {
    if (!MODES.includes(value)) {
      this.log(`thermostat mode ${value} refused: only heat and off, nothing sent`);
      throw new Error(`no such mode: ${value}`);
    }
    await this._power(value === 'heat', 'thermostat_mode');
  }

  // On or off, from onoff or thermostat_mode; the other one follows.
  async _power(on, from) {
    const what = on ? 'on' : 'off';
    const { net, location } = this._controlTarget(what);
    const other = from === 'onoff' ? ['thermostat_mode', on ? 'heat' : 'off'] : ['onoff', on];
    this.setCapabilityValue(...other).catch(() => {});
    if (this._status && this._status.on === on) {
      this.log(`${what}: the thermostat is ${what} already, nothing sent`);
      return;
    }
    this._beforeChange('power');
    this._asked = { ...this._asked, on };
    this._expect({ on });
    const data = thermostatPowerData({ meshId: this.getCsrMeshId(), location, on, tid: this._nextTid() });
    // Once, as before; the newest one counts (its newest flag).
    const run = { newest: true };
    this._latest.power = run;
    this._inBackground(this._send(net, data, `FF42 ${what}`, 'power').then((sent) => {
      if (sent === true) this._written('power', { on }, run.newest);
      else if (sent === false && run.newest) this._notWritten('power', `FF42 ${what}`);
    }), `FF42 ${what}`);
  }

  // The thermostat has a preset already when its status (outside the quiet
  // time) shows it on at the preset's temperature; a pause is not counted.
  async _preset(preset) {
    if (!PRESETS.includes(preset)) throw new Error(`no such preset: ${preset}`);
    const what = `preset ${preset}`;
    const { net, location } = this._controlTarget(what);
    const temperature = this._presets ? this._presets[preset] : undefined;
    if (this._status && Date.now() >= this._quietUntil && this._status.on && temperature === this._status.setPoint) {
      this.log(`${what}: the thermostat has it already, nothing sent`);
      return;
    }
    this._beforeChange('setPoint');
    this._chosenPreset = preset;
    // The preset sets the set point: one sent before it is not compared.
    const asked = { ...this._asked, preset };
    delete asked.setPoint;
    this._asked = asked;
    const data = thermostatPresetData({ meshId: this.getCsrMeshId(), location, preset, tid: this._nextTid() });
    const fields = temperature === undefined ? {} : { setPoint: temperature };
    this._inBackground(this._sendRepeated(net, data, `FF03 ${what}`, PRESET_OPCODE, fields), what);
  }

  // A change refused here (nothing sent) leaves the value as it was, but the
  // Homey app may keep showing what was chosen, such as where the wheel was
  // turned to. So SHOW_AGAIN_MS later the capability's options are set
  // again, unchanged, which hands the device to the app anew with the value
  // it has (assumed: not tried in the Homey app). The value itself is never
  // set again: that would run the "changed" Flow cards, give a refused Flow
  // a change, and could overwrite a status that came meanwhile. Also for
  // onoff, whose button is on every thermostat's tile.
  async _orShowAgain(capability, change) {
    try {
      await change();
    } catch (err) {
      const timer = this.homey.setTimeout(() => {
        this._showAgainTimers.delete(timer);
        this.setCapabilityOptions(capability, this._optionsOf(capability))
          .then(() => this.log(`${capability} shown again after a refused change`))
          .catch((e) => this.error(`${capability} not shown again: ${e.message || e}`));
      }, SHOW_AGAIN_MS);
      this._showAgainTimers.add(timer);
      throw err;
    }
  }

  // A capability's options as they are, which setting them replaces in
  // full: the driver's, with the device's own over them, so a set read
  // empty or in part never drops one the driver gives (such as the hidden
  // thermostat mode or the range 5 to 35).
  _optionsOf(capability) {
    const manifest = (this.driver && this.driver.manifest) || {};
    const options = { ...((manifest.capabilitiesOptions || {})[capability] || {}) };
    let own = null;
    try {
      own = this.getCapabilityOptions(capability);
    } catch (err) {
      // none read for it yet
    }
    for (const [key, value] of Object.entries(own || {})) {
      if (value !== undefined) options[key] = value;
    }
    return options;
  }

  // What was just sent counts as the thermostat's until its next status
  // after the quiet time, which shows what it took.
  _expect(fields) {
    if (this._status) this._status = { ...this._status, ...fields };
  }

  // ---- what the network hands over

  // FF11 from this thermostat (lib/CsrNetwork.js). One with location id 0
  // says it is in no home (assumed, as for the other devices), kept in its
  // store until an FF11 with another one (lib/homeLocation.js, noteNoHome;
  // _commandLocation).
  applyCsrName(name) {
    this._saidNoHome = noteNoHome(this, name.location);
    if (name.location) this._learnLocation(name.location);
  }

  // An answer from this thermostat: FF05, FF3D, FF5C, FF5D or FF08, read.
  applyThermostat(kind, parsed) {
    if (parsed.location && this._learnLocation(parsed.location) === 'other') {
      if (!this._otherLines) this._otherLines = new Map();
      const line = otherLocationLine(this._otherLines, this._location, kind === 'FF05' ? 'status FF05' : kind, Date.now(),
        { windowMs: LOG_WINDOW_MS, perWindow: LOG_PER_SENDER });
      if (line) this.log(line);
      return;
    }
    if ((kind === 'FF08' || kind === 'FF05') && this._commandTimer) this._commandTimer.status();
    if (kind === 'FF08') this._acknowledged(parsed);
    else if (kind === 'FF05') this._applyStatus(parsed);
    else if (kind === 'FF3D') this._applyTemperatures(parsed);
    else if (kind === 'FF5D') this._applyPresets(parsed);
  }

  _applyStatus(status) {
    const now = Date.now();
    const quiet = now < this._quietUntil;
    // Within the quiet time, what was set stays what the thermostat has.
    const kept = quiet && this._status;
    this._status = kept
      ? { ...status, on: this._status.on, setPoint: this._status.setPoint, paused: this._status.paused } : status;
    if (!kept) this._known = { on: status.on, setPoint: status.setPoint };
    if (!quiet) {
      if (this._asked) this._compareWithAsked(status);
      this._set('onoff', status.on);
      this._set('thermostat_mode', status.on ? 'heat' : 'off');
      this._set('target_temperature', status.setPoint);
      this._set('sg_heat_preset', this._presetOf(status));
    }
    this._set('sg_heating', status.heating);
    this._set('sg_window_open', status.window);
    this._noteSensor(status.sensor || null);
    this._applyPower();
    // The temperatures are shown again with the faults this status brings,
    // such as a floor temperature that is empty from now with FFF.
    if (this._temperatures) this._applyTemperatures(this._temperatures);
    else {
      this._mainBeforeTemperatures();
      this._applyFaults();
    }
    const line = `status FF05 ${quiet ? 'during the quiet time after a setting: set point and on/off not taken' : 'applied'}: `
      + `on=${status.on} setPoint=${degrees(status.setPoint)} heating=${status.heating} window=${status.window} `
      + `errors=0x${status.errors.toString(16).padStart(2, '0')}`;
    if (typeof this.homey.app.logStatus === 'function') this.homey.app.logStatus(this, line);
    else this.log(line);
  }

  // What was set from here against what the thermostat has: logged when it
  // differs, and the thermostat's value is shown. Nothing is sent again.
  _compareWithAsked(status) {
    const asked = this._asked;
    this._asked = null;
    if (asked.setPoint !== undefined && asked.setPoint !== status.setPoint) {
      this.log(`set point ${degrees(asked.setPoint)} was sent, the thermostat has ${degrees(status.setPoint)}: shown as it is`);
    }
    if (asked.on !== undefined && asked.on !== status.on) {
      this.log(`${asked.on ? 'on' : 'off'} was sent, the thermostat is ${status.on ? 'on' : 'off'}: shown as it is`);
    }
  }

  // The preset the status shows: none when off; min when paused (assumed);
  // otherwise the one whose temperature is the set point, the one chosen here
  // first when two have it.
  _presetOf(status) {
    if (!status.on) return null;
    if (status.paused) return 'min';
    if (!this._presets) return null;
    const matches = PRESETS.filter((preset) => this._presets[preset] === status.setPoint);
    if (!matches.length) return null;
    return matches.includes(this._chosenPreset) ? this._chosenPreset : matches[0];
  }

  // The temperatures, as the settings say. Each sensor has its own
  // capability, measure_temperature.floor and measure_temperature.room, and
  // measure_temperature is the one "Displayed temperature" chooses
  // (_shownSensor), with no other in its place when that one has none: then
  // it is empty, and the warning says why (_applyFaults).
  // - The floor: never with the sensor Room.
  // - The room: with Floor, a reading of 0 counts as no room sensor.
  // 0.0 is shown as 0.0. Empty with a sensor fault: E2 for the room, FFF for
  // the floor, and E1, whose floor reads 0.
  _applyTemperatures(temperatures, settings = this.getSettings()) {
    this._temperatures = temperatures;
    const errors = this._status ? this._status.errors : 0;
    const sensor = this._sensor(settings);
    const reads = (value) => typeof value === 'number' && Number.isFinite(value);
    const roomShown = reads(temperatures.room) && !roomSensorFault(errors)
      && (temperatures.room > 0 || (temperatures.room === 0 && sensor !== 'floor'));
    const room = roomShown ? temperatures.room : null;
    const floorBits = floorSensorOf(errors);
    const floorShown = sensor !== 'room' && reads(temperatures.floor) && temperatures.floor >= 0
      && floorBits !== 1 && !(floorBits === 2 && temperatures.floor === 0);
    const floor = floorShown ? temperatures.floor : null;
    const shown = this._shownSensor(settings);
    const main = shown === 'floor' ? floor : room;
    this._set('measure_temperature', main);
    this._set('measure_temperature.floor', floor);
    this._set('measure_temperature.room', room);
    this._shownMissing = main === null ? shown : null;
    this._applyFaults(settings);
  }

  // The temperatures Homey kept from before this start, each a number or
  // null: measure_temperature (main), .floor and .room.
  _keptTemperatures() {
    const kept = (id) => {
      const read = this.hasCapability(id) ? this.getCapabilityValue(id) : null;
      return typeof read === 'number' && Number.isFinite(read) ? read : null;
    };
    return { main: kept('measure_temperature'), floor: kept('measure_temperature.floor'), room: kept('measure_temperature.room') };
  }

  // Before the first temperatures since start (FF3D), at each status and
  // each change of the settings: measure_temperature from those kept at
  // start (_kept), never from what it showed since, by the rules of
  // _applyTemperatures for what the status gives. Otherwise it could stay
  // what an earlier version showed, the room, until the first FF3D.
  // - The floor shown: the kept floor; empty with the sensor Room, with
  //   FFF, and with E1, whose floor reads 0: the floor sensor bits 10 and a
  //   kept floor of 0.
  // - The room shown: the kept room; empty with E2, and a kept room of 0
  //   with the sensor Floor, which counts as no room sensor. When
  //   measure_temperature.room was not there at this start (added by
  //   _roomCapability, or not added) it has none, and the kept main
  //   temperature is used: an earlier version showed the room there when it
  //   had one. Known and kept: at the first start after the update, a
  //   thermostat without a room reading, whose main temperature the earlier
  //   version showed as the floor's, shows that floor temperature as the
  //   room's until the first FF3D.
  // Only measure_temperature: the others stay as kept until the first FF3D.
  // No warning of its own: that comes with the temperatures.
  _mainBeforeTemperatures(settings = this.getSettings()) {
    if (this._temperatures || !this._kept || !this._status) return;
    const { errors } = this._status;
    const kept = this._kept;
    const sensor = this._sensor(settings);
    let main;
    if (this._shownSensor(settings) === 'floor') {
      const floorBits = floorSensorOf(errors);
      main = sensor !== 'room' && floorBits !== 1 && !(floorBits === 2 && kept.floor === 0) ? kept.floor : null;
    } else if (roomSensorFault(errors)) {
      main = null;
    } else if (kept.room === null) {
      main = this._noRoomBefore ? kept.main : null;
    } else {
      main = kept.room > 0 || (kept.room === 0 && sensor !== 'floor') ? kept.room : null;
    }
    this._set('measure_temperature', main);
  }

  _applyPresets({ presets }) {
    const [comfort, eco, min] = presets;
    this._presets = { comfort, eco, min };
    if (this._status && Date.now() >= this._quietUntil) this._set('sg_heat_preset', this._presetOf(this._status));
  }

  // measure_power always, also while the cable's power is 0 W (then empty):
  // Homey gives a device with onoff and without measure_power its own power
  // usage when on and off, which counts by on and off rather than by the
  // relay, and next to the cable's power. Added at start to a thermostat
  // that lacks it, and marked as approximated, as the driver's options are
  // not assumed to come with it. A failure is logged.
  async _powerCapability() {
    if (this.hasCapability('measure_power')) return;
    try {
      await this.addCapability('measure_power');
      this.log('measure_power added');
    } catch (err) {
      this.error(`measure_power not added: ${err.message || err}`);
      return;
    }
    await this.setCapabilityOptions('measure_power', { approximated: true })
      .catch((err) => this.error(`measure_power not marked as approximated: ${err.message || err}`));
  }

  // measure_temperature.room, the room sensor on its own: added at start to
  // a thermostat that lacks it, with its title, as the driver's options are
  // not assumed to come with it. One that has it without a title (the title
  // failed at an earlier start) gets the title. Reading the options of a
  // capability that has none throws, and that counts as no title, as in
  // _quickAction. A failure is logged, and tried again at the next start.
  async _roomCapability() {
    const id = 'measure_temperature.room';
    if (!this.hasCapability(id)) {
      try {
        await this.addCapability(id);
        this.log(`${id} added`);
      } catch (err) {
        this.error(`${id} not added: ${err.message || err}`);
        return;
      }
    } else {
      let own = null;
      try {
        own = this.getCapabilityOptions(id);
      } catch (err) {
        // none read for it yet
      }
      if (own && own.title) return;
    }
    try {
      await this.setCapabilityOptions(id, { title: { en: 'Room temperature', no: 'Romtemperatur' } });
    } catch (err) {
      this.error(`${id} without its title: ${err.message || err}`);
    }
  }

  // The on/off quick action on the tile is shown for every thermostat. An
  // earlier version hid it for one with control from Homey off, and that
  // one has uiQuickAction false stored: read so, it is set to true, which
  // happens once. Otherwise nothing is set: without the option it counts as
  // shown, as Homey shows it by default. Reading the options of a
  // capability that has none throws (a thermostat added before the driver
  // gave onoff its options), and that counts as none. At start; a failure
  // to set is logged, and tried again at the next start.
  async _quickAction() {
    if (!this.hasCapability('onoff')) return;
    let own = null;
    try {
      own = this.getCapabilityOptions('onoff');
    } catch (err) {
      // none read for it yet
    }
    if (!own || own.uiQuickAction !== false) return;
    try {
      await this.setCapabilityOptions('onoff', { uiQuickAction: true });
      this.log('on/off on the tile shown: it was hidden by an earlier version');
    } catch (err) {
      this.error(`on/off on the tile not shown: ${err.message || err}`);
    }
  }

  // The heating cable's power when the relay is in, 0 when it is out; empty
  // without the cable's power in the settings.
  _applyPower(settings = this.getSettings()) {
    const watts = Number(settings.heating_cable_power) || 0;
    if (watts <= 0 || !this._status) {
      this._set('measure_power', null);
      return;
    }
    this._set('measure_power', this._status.heating ? watts : 0);
  }

  // The faults, as the sensor the thermostat uses (_sensor) says: a problem
  // (alarm_problem) for PROBLEMS, and the first one as the warning. The
  // shown sensor's own faults (FFF and E1 for the floor, E2 for the room)
  // are in the warning too when the thermostat does not use that sensor,
  // but are no problem: the thermostat regulates as before. Without a fault,
  // an empty shown temperature has a warning of its own (shownMissing): no
  // room sensor, or the floor with the sensor Room.
  _applyFaults(settings = this.getSettings()) {
    if (!this._status) return;
    const faults = faultsOf(this._status.errors, this._temperatures, this._sensor(settings));
    const ofShown = faultsOf(this._status.errors, this._temperatures, this._shownSensor(settings))
      .filter((code) => code !== 'L0');
    this._set('alarm_problem', faults.some((code) => PROBLEMS.includes(code)));
    this._set('sg_floor_limit', !!(this._status.errors & FLOOR_LIMIT_BIT) && this._sensor(settings) !== 'room');
    const shown = FAULT_ORDER.filter((code) => faults.includes(code) || ofShown.includes(code));
    const fault = shown[0] || null;
    const missing = !fault && this._shownMissing ? this._shownMissing : null;
    if (fault === (this._fault || null) && missing === (this._missing || null)) return;
    if (fault !== (this._fault || null)) {
      const also = shown.length > 1 ? ` (also ${shown.slice(1).join(', ')})` : '';
      this.log(fault ? `fault shown: ${fault}${also}` : 'fault cleared');
    }
    if (missing !== (this._missing || null)) {
      this.log(missing ? `shown temperature empty: no ${missing} temperature` : 'shown temperature read again');
    }
    this._fault = fault;
    this._missing = missing;
    this.updateAvailability();
  }

  // A set point or a preset another sent this thermostat (lib/CsrNetwork.js):
  // shown, never answered or sent on. Dropped within OTHERS_QUIET_MS of a
  // setting from here, and when its tid is not newer than the last one
  // (TID_RESET_S); one taken makes its tid the thermostat's.
  applyThermostatCommand(kind, parsed, src) {
    const now = Date.now();
    const from = `${kind} from ${hex4(src)}`;
    if (parsed.location !== this.getCsrLocationId()) return;
    if (now < this._othersQuietUntil) {
      this.log(`${from} not taken: within ${OTHERS_QUIET_MS / 1000} s of a setting from here`);
      return;
    }
    const recent = Math.floor((now - this._lastTidAt) / 1000) <= TID_RESET_S;
    if (parsed.tid === 0 || (recent && parsed.tid <= this._tid)) return;
    this._tid = parsed.tid;
    this._lastTidAt = now;
    this._quietUntil = now + QUIET_MS;
    if (kind === 'FF3E') {
      this._set('target_temperature', parsed.setPoint);
      if (this._status) this._status = { ...this._status, setPoint: parsed.setPoint };
      this._known = { ...(this._known || {}), setPoint: parsed.setPoint };
      this.log(`${from}: set point ${degrees(parsed.setPoint)} shown`);
    } else {
      this._chosenPreset = parsed.preset;
      this._set('sg_heat_preset', parsed.preset);
      if (this._presets && this._presets[parsed.preset] !== undefined) {
        this._set('target_temperature', this._presets[parsed.preset]);
        this._known = { ...(this._known || {}), setPoint: this._presets[parsed.preset] };
      }
      this.log(`${from}: preset ${parsed.preset} shown`);
    }
  }

  // The new settings count from now: the power and the faults are shown
  // with them at once. "Sensor" changed: the mark that it was set to
  // Automatic is stored too, if it is not there (_settingsAtStart).
  async onSettings({ newSettings, changedKeys }) {
    this._applyPower(newSettings);
    const sensorBy = changedKeys.includes('sensor');
    if (sensorBy) await this._storeSensorMark();
    if (sensorBy && this._sensorRead !== undefined) this._noteSensor(this._sensorRead, newSettings);
    const shownBy = sensorBy || changedKeys.includes('shown_temperature');
    if (shownBy && this._temperatures) this._applyTemperatures(this._temperatures, newSettings);
    else if (shownBy) this._mainBeforeTemperatures(newSettings);
    this._applyFaults(newSettings);
  }

  _set(capability, value) {
    if (!this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value).catch((err) => this.error(`${capability} failed: ${err.message || err}`));
  }
}

module.exports = SGThermostatDevice;
module.exports.faultsOf = faultsOf;
module.exports.setPointFor = setPointFor;
