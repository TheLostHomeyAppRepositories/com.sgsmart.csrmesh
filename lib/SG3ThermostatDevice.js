'use strict';

const Homey = require('homey');
const SGMeshDevice = require('./SGDeviceBase');
const { sg3CanBeBridge } = require('./sgProducts');
const { parseSg3Id } = require('./SG3Device');
const {
  FAULT_ORDER, FLOOR_LIMIT_BIT, PROBLEMS, faultsOf, floorSensorOf, roomSensorFault,
} = require('./SGThermostatDevice');

// HeatReg Smart 3.0 (type 3021), the device of the driver HeatReg Smart 3.0
// (drivers/sg3_thermostat). Its id is "sig:<home key>:<address>", as a 3.0
// dimmer's (lib/SG3Device.js); its keys and the link are the app's (app.js,
// sg3, and lib/sg3/controller.js).
//
// Read: the status the thermostat sends by itself on a link that is up
// (lib/sg3/controller.js, 'thermostat'; tried in part, see
// lib/sg3/protocol.js, parseThermostatStatus). It is never asked for its
// status (sg3ListensOnly, app.js). After a start the values Homey kept are
// shown until its first status. A link is opened for the 3.0 dimmers in
// Homey only; without one, there is no link, and nothing is heard from it.
//
// Set: on and off (onoff, and thermostat_mode heat or off) with 0x18, the
// set point with 0x19 after SET_POINT_DEBOUNCE_MS (both tried on a
// thermostat on 2026-11-21), and the preset (sg_heat_preset) with 0x08,
// which sets the set point to the preset's temperature too (assumed, not
// tried), as HeatReg Smart (lib/SGThermostatDevice.js).
// One send per change, never again (lib/sg3/controller.js, setThermostat);
// nothing is sent when its last status has the value already and nothing of
// the kind is under way. Homey shows the change at once and does not wait
// for the send. With the thermostat's acknowledgement its value is shown;
// without one within 3 s, when it refused a preset, or when it was not sent,
// a line in the log, and Homey shows again what the thermostat last reported
// (or, before its first status since start, what Homey had kept), unless a
// newer change of the same kind came meanwhile. What it acknowledged counts
// as what it last reported, until its next status, which is what counts.
//
// The preset in use (_presetOf): none when off; min when the thermostat says
// min is in use; else the one of comfort and eco whose temperature is the
// set point, the one chosen here last when both have it (they cannot be
// told apart), else comfort; none when neither has it.
//
// The temperatures as HeatReg Smart shows them: measure_temperature.room and
// .floor, and measure_temperature as "Displayed temperature" says: Automatic
// follows the sensor the thermostat reports (Floor when it reports none, as
// HeatReg Smart), else the sensor chosen. The floor is empty when the
// thermostat uses only the room sensor, and the room empty at 0 when it uses
// only the floor sensor. Its protection byte is read as HeatReg Smart's fault
// byte (faultsOf): the floor is empty with FFF and with E1 (no reading), the
// room with E2; a fault of the sensor it uses is a problem (alarm_problem),
// and the first fault, or an empty displayed temperature, is the warning, in
// HeatReg Smart's words. The floor limit (sg_floor_limit) is its bit 7, as
// HeatReg Smart's (assumed), and the open window (sg_window_open) that the
// function has gone off (assumed). Heating (sg_heating) is its relay, and
// measure_power the heating cable's power while it heats ("Heating cable
// power"; empty at 0 W), approximated. It has no "Sensor" setting: the
// thermostat reports its sensor itself.
//
// "Signal to Homey" and "Link" as for a 3.0 dimmer (lib/SG3Device.js): the
// link never goes through it, so "Link" is always "Indirect", and the signal
// is that of its advertisement (type byte 0xB4 and its address,
// lib/sg3/advert.js) whenever Homey sees it in a scan of this app or when a
// link is set up (lib/sg3/controller.js, 'advert'); no scan is made for it.
// Empty until the first one; as the first generation's (lib/SGDeviceBase.js,
// setSignal), a median, changed at most once an hour.

// "Displayed temperature".
const SHOWN_TEMPERATURES = ['auto', 'floor', 'room'];
const SET_POINT_MIN = 5;
const SET_POINT_MAX = 35;
const SET_POINT_STEP = 0.5;
// A set point dragged in Homey goes when it has rested this long, as for
// HeatReg Smart.
const SET_POINT_DEBOUNCE_MS = 1500;
const PRESETS = ['comfort', 'eco', 'min'];
// The type it has in the account and in its advertisement (lib/sg3/advert.js).
const THERMOSTAT_TYPE = 3021;
// Added at start to one added before it had them, the signal with its name.
const LATER_CAPABILITIES = ['sg_heat_preset', 'sg_window_open', 'sg_floor_limit', 'alarm_problem', 'measure_signal_strength', 'sg_connection'];
const SIGNAL_TITLE = { en: 'Signal to Homey', no: 'Signal til Homey' };

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const degrees = (value) => (value === null || value === undefined ? '-' : value.toFixed(1));
const reads = (value) => typeof value === 'number' && Number.isFinite(value);
const inRange = (value) => reads(value) && value >= SET_POINT_MIN && value <= SET_POINT_MAX;

class SG3ThermostatDevice extends Homey.Device {
  async onInit() {
    const parsed = parseSg3Id(this.getData().id);
    this._address = parsed.address;
    this._homeKey = parsed.homeKey;
    this._sg3 = null;
    this._shown = null;
    this._status = null;
    this._said = null;
    this._fault = null;
    this._missing = null;
    this._warningShown = undefined;
    this._chosenPreset = null;
    this._onThermostat = (status) => {
      if (status.node === this._address) this.applyThermostat(status);
    };
    this._onAdvert = ({ address, type, rssi }) => {
      if (address === this._address && type === THERMOSTAT_TYPE) SGMeshDevice.prototype.setSignal.call(this, rssi);
    };
    // What Homey kept at start, shown again after a change that did not get
    // through before the first status (_showReported).
    this._kept = {
      power: this.getCapabilityValue('onoff'),
      setPoint: this.getCapabilityValue('target_temperature'),
      preset: this.hasCapability('sg_heat_preset') ? this.getCapabilityValue('sg_heat_preset') : null,
    };
    // The changes of each kind from Homey, counted: an older one's answer
    // does not undo a newer one.
    this._changes = { power: 0, setPoint: 0, preset: 0 };
    // The sends of each kind under way: while one is, the last status may be
    // older than it, so a change is sent also when the status has its value.
    this._sending = { power: 0, setPoint: 0, preset: 0 };
    this._setPointTimer = null;
    this.registerCapabilityListener('onoff', async (value) => this._power(value === true));
    this.registerCapabilityListener('thermostat_mode', async (value) => this._power(value === 'heat'));
    this.registerCapabilityListener('target_temperature', async (value) => this._setPointSoon(value));
    this.registerCapabilityListener('sg_heat_preset', async (value) => this._preset(value));
    await this._laterCapabilities();
    // Never the bridge: "Indirect".
    SGMeshDevice.prototype.setConnection.call(this, false);
    await this.updateSg3();
    const { app } = this.homey;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
    this.log(`HeatReg Smart 3.0 ready (${this.getStoreValue('sg3Type')}, address ${hex4(this._address)})`);
  }

  // One added before these came gets them, and the signal its name (Athom:
  // guides/how-to-breaking-changes.md), as a 3.0 dimmer does.
  async _laterCapabilities() {
    for (const capability of LATER_CAPABILITIES) {
      if (this.hasCapability(capability)) continue;
      await this.addCapability(capability)
        .then(() => this.log(`${capability} added`), (err) => this.error(`adding ${capability} failed: ${err.message || err}`));
    }
    if (!this.hasCapability('measure_signal_strength')) return;
    let current = null;
    try {
      current = (this.getCapabilityOptions('measure_signal_strength') || {}).title;
    } catch { /* no options yet */ }
    if (!current || current.en !== SIGNAL_TITLE.en || current.no !== SIGNAL_TITLE.no) {
      await this.setCapabilityOptions('measure_signal_strength', { title: SIGNAL_TITLE })
        .catch((err) => this.error(`naming the signal failed: ${err.message || err}`));
    }
  }

  // ---- set from Homey

  // On or off from Homey (onoff or thermostat_mode): shown at once, both
  // capabilities, and sent unless its last status has it and nothing of the
  // kind is under way.
  _power(on) {
    const said = on ? 'on' : 'off';
    this._changes.power += 1;
    this._showPower(on);
    if (this._status && this._status.on === on && this._sending.power === 0) {
      this.log(`${said} from Homey: the thermostat is ${said} already, nothing sent`);
      return;
    }
    this._send('power', on, `${said} from Homey`, this._changes.power);
  }

  // A set point from Homey: from 5 to 35 in steps of 0.5, sent once it has
  // rested SET_POINT_DEBOUNCE_MS, unless its last status has it and nothing
  // of the kind is under way.
  _setPointSoon(value) {
    const stepped = Math.max(SET_POINT_MIN, Math.min(SET_POINT_MAX, Math.round(Number(value) / SET_POINT_STEP) * SET_POINT_STEP));
    if (!Number.isFinite(stepped)) throw new Error(`not a set point: ${value}`);
    if (this._setPointTimer) this.homey.clearTimeout(this._setPointTimer);
    this._changes.setPoint += 1;
    const change = this._changes.setPoint;
    this._setPointTimer = this.homey.setTimeout(() => {
      this._setPointTimer = null;
      if (change !== this._changes.setPoint) return;
      if (this._status && this._status.setPoint === stepped && this._sending.setPoint === 0) {
        this.log(`set point ${degrees(stepped)} from Homey: the thermostat has it already, nothing sent`);
        this._set('target_temperature', stepped);
        return;
      }
      this._send('setPoint', stepped, `set point ${degrees(stepped)} from Homey`, change);
    }, SET_POINT_DEBOUNCE_MS);
  }

  // A preset from Homey (the picker, or the Flow card through it): shown at
  // once, with its temperature as the set point when its last status has it,
  // and sent unless its last status has that preset and nothing of the kind
  // is under way.
  _preset(value) {
    if (!PRESETS.includes(value)) throw new Error(`not a preset: ${value}`);
    // What its status showed before this choice: eco chosen while comfort
    // and eco have the same temperature and comfort was shown is sent.
    const before = this._status ? this._presetOf(this._status) : null;
    this._chosenPreset = value;
    this._changes.preset += 1;
    this._set('sg_heat_preset', value);
    if (this._status && inRange(this._status[value])) this._set('target_temperature', this._status[value]);
    if (before === value && this._sending.preset === 0) {
      this.log(`preset ${value} from Homey: the thermostat has it already, nothing sent`);
      return;
    }
    this._send('preset', value, `preset ${value} from Homey`, this._changes.preset);
  }

  // One send (lib/sg3/controller.js, setThermostat), in the background;
  // change is the count of the change it is (_changes).
  _send(kind, value, said, change) {
    const sg3 = this._sg3;
    if (!sg3 || typeof sg3.setThermostat !== 'function') {
      this.log(`${said}: not sent, no 3.0 network`);
      this._showReported(kind);
      return;
    }
    this._sending[kind] += 1;
    const sent = sg3.setThermostat(this._address, { [kind]: value });
    sent.catch(() => {}).finally(() => {
      this._sending[kind] -= 1;
    });
    sent.then((result) => {
      if (!result || result.superseded) return;
      const current = change === this._changes[kind];
      if (result.ack && result.ack.refused) {
        this.log(`${said}: refused by the thermostat, not sent again`);
        if (current) this._showReported(kind);
        return;
      }
      if (result.ack) {
        this.log(`${said}: acknowledged by the thermostat (${result.ack.values.join(' ')})`);
        this._acknowledged(kind, value, result.ack.values);
        if (current) this._showReported(kind);
        return;
      }
      this.log(`${said}: no acknowledgement from the thermostat within 3 s, not sent again`);
      if (current) this._showReported(kind);
    }, (err) => {
      this.log(`${said}: not sent (${err.message || err})`);
      if (change === this._changes[kind]) this._showReported(kind);
    });
  }

  // What it acknowledged is what it last reported, until its next status:
  // on or off; the set point; a preset, with its temperature as the set
  // point when the status has it, and min in use or not.
  _acknowledged(kind, value, values) {
    let reported;
    if (kind === 'power') reported = { on: values[0] === 1 };
    else if (kind === 'setPoint') reported = { setPoint: values.length >= 2 ? values[0] + values[1] / 10 : value };
    else {
      reported = { minActive: value === 'min' };
      const known = this._status ? this._status[value] : null;
      if (inRange(known)) reported.setPoint = known;
    }
    if (this._status) {
      this._status = { ...this._status, ...reported };
      return;
    }
    if (kind === 'power') this._kept.power = reported.on;
    if (reported.setPoint !== undefined) this._kept.setPoint = reported.setPoint;
    if (kind === 'preset') this._kept.preset = value;
  }

  _showPower(on) {
    this._set('onoff', on);
    this._set('thermostat_mode', on ? 'heat' : 'off');
  }

  // What the thermostat last reported for this kind, or before its first
  // status what Homey kept at start. The preset follows on and off and the
  // set point.
  _showReported(kind) {
    const status = this._status;
    if (kind === 'power') {
      const on = status ? status.on : this._kept.power;
      if (typeof on === 'boolean') this._showPower(on);
    } else {
      const setPoint = status ? status.setPoint : this._kept.setPoint;
      if (inRange(setPoint)) this._set('target_temperature', setPoint);
    }
    if (status) this._set('sg_heat_preset', this._presetOf(status));
    else if (kind === 'preset') this._set('sg_heat_preset', this._kept.preset);
  }

  // The preset in use (see the top).
  _presetOf(status) {
    if (!status.on) return null;
    if (status.minActive) return 'min';
    const matches = ['comfort', 'eco'].filter((preset) => reads(status[preset]) && status[preset] === status.setPoint);
    if (!matches.length) return null;
    return matches.includes(this._chosenPreset) ? this._chosenPreset : matches[0];
  }

  // ---- the device and the link

  // null once deleted: Homey may still list the device while onDeleted runs.
  getSg3Address() {
    return this._deleted ? null : this._address;
  }

  getSg3HomeKey() {
    return this._homeKey;
  }

  // Never asked for its status, and set only from here (app.js,
  // deviceAddresses).
  sg3ListensOnly() {
    return true;
  }

  // Never carries Homey's link (lib/sgProducts.js, bridge false).
  canBeSg3Bridge() {
    return sg3CanBeBridge(this.getStoreValue('sg3Type'));
  }

  // The app's 3.0 controller as it is now, as for a 3.0 dimmer
  // (lib/SG3Device.js, updateSg3). It is not started from here: a link is
  // the dimmers' (see the top).
  async updateSg3() {
    const { app } = this.homey;
    const sg3 = app && typeof app.sg3 === 'function' ? app.sg3() : null;
    const ours = sg3 && app.sg3HomeKey() === this._homeKey ? sg3 : null;
    if (ours !== this._sg3) {
      this._detach();
      this._sg3 = ours;
      if (ours) {
        ours.on('thermostat', this._onThermostat);
        ours.on('advert', this._onAdvert);
      }
    }
    let why = null;
    if (!ours) why = sg3 ? 'device.sg3ThermostatOtherHome' : 'device.sg3NoNetwork';
    if (why === this._shown) return;
    this._shown = why;
    if (why) {
      this.log(`unavailable: ${sg3 ? 'the account\'s 3.0 network is another home\'s' : 'no 3.0 network in the SG account'}`);
      await this.setUnavailable(this.homey.__(why)).catch(() => {});
    } else {
      await this.setAvailable().catch(() => {});
    }
  }

  // ---- what it reports

  // Its status (lib/sg3/controller.js, 'thermostat'): shown, and logged at
  // the first one since start and when what it says changes.
  applyThermostat(status) {
    this._status = status;
    const said = `room ${degrees(status.room)}, floor ${degrees(status.floor)}, set point ${degrees(status.setPoint)}, `
      + `eco ${degrees(status.eco)}, comfort ${degrees(status.comfort)}, min ${degrees(status.min)}${status.minActive ? ' (in use)' : ''}, `
      + `sensor ${status.sensor || 'not given'}, ${status.heating ? 'heating' : 'not heating'}, ${status.on ? 'on' : 'off'}, `
      + `window ${status.window ? 'open' : 'not open'}, protection 0x${(status.protection || 0).toString(16).padStart(2, '0')}`;
    if (said !== this._said) this.log(`status: ${said}${this._said === null ? ' (first since start)' : ''}`);
    this._said = said;
    this._showPower(status.on);
    this._set('sg_heating', status.heating);
    this._set('sg_window_open', status.window === true);
    if (inRange(status.setPoint)) {
      this._set('target_temperature', status.setPoint);
    } else if (reads(status.setPoint)) {
      this.log(`set point ${degrees(status.setPoint)} not shown: outside ${SET_POINT_MIN} to ${SET_POINT_MAX}`);
    }
    this._set('sg_heat_preset', this._presetOf(status));
    this._applyTemperatures();
    this._applyPower();
  }

  // The sensor that counts for Automatic: the one it reports, else Floor.
  _sensor() {
    return (this._status && this._status.sensor) || 'floor';
  }

  // The sensor measure_temperature shows ("Displayed temperature").
  _shownSensor(settings = this.getSettings()) {
    const chosen = SHOWN_TEMPERATURES.includes(settings.shown_temperature) ? settings.shown_temperature : 'auto';
    if (chosen !== 'auto') return chosen;
    return this._sensor() === 'floor' ? 'floor' : 'room';
  }

  // The temperatures (see the top), then the faults and the warning.
  _applyTemperatures(settings = this.getSettings()) {
    if (!this._status) return;
    const { room: roomRead, floor: floorRead } = this._status;
    const errors = this._status.protection || 0;
    const sensor = this._sensor();
    const floorBits = floorSensorOf(errors);
    const room = reads(roomRead) && !roomSensorFault(errors) && (roomRead !== 0 || sensor !== 'floor') ? roomRead : null;
    const floor = sensor !== 'room' && reads(floorRead) && floorBits !== 1 && !(floorBits === 2 && floorRead === 0) ? floorRead : null;
    const shown = this._shownSensor(settings);
    const main = shown === 'floor' ? floor : room;
    this._set('measure_temperature', main);
    this._set('measure_temperature.floor', floor);
    this._set('measure_temperature.room', room);
    this._shownMissing = main === null ? shown : null;
    this._applyFaults(settings);
  }

  // The faults, as for HeatReg Smart (lib/SGThermostatDevice.js,
  // _applyFaults): a problem for those of the sensor it uses, the floor limit
  // unless it uses only the room sensor, and the warning.
  _applyFaults(settings = this.getSettings()) {
    if (!this._status) return;
    const errors = this._status.protection || 0;
    // A temperature that does not read is not one of 0 or below (L0).
    const temperatures = {
      room: reads(this._status.room) ? this._status.room : NaN,
      floor: reads(this._status.floor) ? this._status.floor : NaN,
    };
    const sensor = this._sensor();
    const faults = faultsOf(errors, temperatures, sensor);
    const ofShown = faultsOf(errors, temperatures, this._shownSensor(settings)).filter((code) => code !== 'L0');
    this._set('alarm_problem', faults.some((code) => PROBLEMS.includes(code)));
    this._set('sg_floor_limit', !!(errors & FLOOR_LIMIT_BIT) && sensor !== 'room');
    const shown = FAULT_ORDER.filter((code) => faults.includes(code) || ofShown.includes(code));
    const fault = shown[0] || null;
    const missing = !fault && this._shownMissing ? this._shownMissing : null;
    if (fault !== this._fault) {
      const also = shown.length > 1 ? ` (also ${shown.slice(1).join(', ')})` : '';
      this.log(fault ? `fault shown: ${fault}${also}` : 'fault cleared');
    }
    if (missing !== this._missing) {
      this.log(missing ? `shown temperature empty: no ${missing} temperature` : 'shown temperature read again');
    }
    this._fault = fault;
    this._missing = missing;
    let warning = null;
    if (fault) warning = this.homey.__(`thermostat.fault.${fault}`);
    else if (missing) warning = this.homey.__(`thermostat.shownMissing.${missing}`);
    if (warning === this._warningShown) return;
    this._warningShown = warning;
    if (warning) this.setWarning(warning).catch(() => {});
    else this.unsetWarning().catch(() => {});
  }

  _applyPower(settings = this.getSettings()) {
    const watts = Number(settings.heating_cable_power) || 0;
    if (watts <= 0 || !this._status) {
      this._set('measure_power', watts <= 0 ? null : undefined);
      return;
    }
    this._set('measure_power', this._status.heating ? watts : 0);
  }

  // A change of "Displayed temperature" or "Heating cable power" counts at
  // once, from the last status (none yet since start: at the first).
  async onSettings({ newSettings, changedKeys }) {
    if (changedKeys.includes('shown_temperature')) this._applyTemperatures(newSettings);
    if (changedKeys.includes('heating_cable_power')) this._applyPower(newSettings);
  }

  // A value, when it differs from what is shown; undefined leaves it.
  _set(capability, value) {
    if (value === undefined || !this.hasCapability(capability)) return;
    if (this.getCapabilityValue(capability) === value) return;
    this.setCapabilityValue(capability, value).catch((err) => this.error(`${capability} not set: ${err.message || err}`));
  }

  async onAdded() {
    const { app } = this.homey;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onDeleted() {
    this._deleted = true;
    this._stopTimer();
    this._detach();
    const { app } = this.homey;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onUninit() {
    this._stopTimer();
    this._detach();
  }

  _stopTimer() {
    if (this._setPointTimer) this.homey.clearTimeout(this._setPointTimer);
    this._setPointTimer = null;
  }

  _detach() {
    if (this._sg3) {
      this._sg3.off('thermostat', this._onThermostat);
      this._sg3.off('advert', this._onAdvert);
    }
    this._sg3 = null;
  }
}

// What the first generation's setSignal and setConnection call for the
// text under "Link", as for a 3.0 dimmer (lib/SG3Device.js).
SG3ThermostatDevice.prototype._showConnection = SGMeshDevice.prototype._showConnection;

module.exports = SG3ThermostatDevice;
