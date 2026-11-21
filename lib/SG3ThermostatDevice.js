'use strict';

const Homey = require('homey');
const { sg3CanBeBridge } = require('./sgProducts');
const { parseSg3Id } = require('./SG3Device');

// HeatReg Smart 3.0 (type 3021), the device of the driver HeatReg Smart 3.0
// (drivers/sg3_thermostat). Its id is "sig:<home key>:<address>", as a 3.0
// dimmer's (lib/SG3Device.js); its keys and the link are the app's (app.js,
// sg3, and lib/sg3/controller.js).
//
// Read: the status the thermostat sends by itself on a link that is up
// (lib/sg3/controller.js, 'thermostat'; the format is assumed, see
// lib/sg3/protocol.js, parseThermostatStatus). It is never asked for its
// status (sg3ListensOnly, app.js). After a start the values Homey kept are
// shown until its first status. A link is opened for the 3.0 dimmers in
// Homey only; without one, there is no link, and nothing is heard from it.
//
// Set (assumed, not tried): on and off (onoff, and thermostat_mode heat or
// off) with 0x18, the set point with 0x19 after SET_POINT_DEBOUNCE_MS, as
// HeatReg Smart (lib/SGThermostatDevice.js). One send per change, never
// again (lib/sg3/controller.js, setThermostat); nothing is sent when its
// last status has the value already. Homey shows the change at once and does
// not wait for the send. With the thermostat's acknowledgement its value is
// shown; without one within 3 s, or when it was not sent, a line in the log,
// and Homey shows again what the thermostat last reported (or, before its
// first status since start, what Homey had kept), unless a newer change of
// the same kind came meanwhile. What it acknowledged counts as what it last
// reported, until its next status, which is what counts.
//
// The temperatures as HeatReg Smart shows them (lib/SGThermostatDevice.js):
// measure_temperature.room and .floor, and measure_temperature as
// "Displayed temperature" says: Automatic follows the sensor the thermostat
// reports (Floor when it reports none, as HeatReg Smart), else the sensor
// chosen. The floor is empty when the thermostat uses only the room sensor,
// and the room empty at 0 when it uses only the floor sensor. Heating
// (sg_heating) is its relay, and measure_power the heating cable's power
// while it heats ("Heating cable power"; empty at 0 W), approximated.
// It has no "Sensor" setting: the thermostat reports its sensor itself.

// "Displayed temperature".
const SHOWN_TEMPERATURES = ['auto', 'floor', 'room'];
const SET_POINT_MIN = 5;
const SET_POINT_MAX = 35;
const SET_POINT_STEP = 0.5;
// A set point dragged in Homey goes when it has rested this long, as for
// HeatReg Smart.
const SET_POINT_DEBOUNCE_MS = 1500;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const degrees = (value) => (value === null ? '-' : value.toFixed(1));
const reads = (value) => typeof value === 'number' && Number.isFinite(value);

class SG3ThermostatDevice extends Homey.Device {
  async onInit() {
    const parsed = parseSg3Id(this.getData().id);
    this._address = parsed.address;
    this._homeKey = parsed.homeKey;
    this._sg3 = null;
    this._shown = null;
    this._status = null;
    this._said = null;
    this._onThermostat = (status) => {
      if (status.node === this._address) this.applyThermostat(status);
    };
    // What Homey kept at start, shown again after a change that did not get
    // through before the first status (_showReported).
    this._kept = { power: this.getCapabilityValue('onoff'), setPoint: this.getCapabilityValue('target_temperature') };
    // The changes of each kind from Homey, counted: an older one's answer
    // does not undo a newer one.
    this._changes = { power: 0, setPoint: 0 };
    // The sends of each kind under way: while one is, the last status may be
    // older than it, so a change is sent also when the status has its value.
    this._sending = { power: 0, setPoint: 0 };
    this._setPointTimer = null;
    this.registerCapabilityListener('onoff', async (value) => this._power(value === true));
    this.registerCapabilityListener('thermostat_mode', async (value) => this._power(value === 'heat'));
    this.registerCapabilityListener('target_temperature', async (value) => this._setPointSoon(value));
    await this.updateSg3();
    const { app } = this.homey;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
    this.log(`HeatReg Smart 3.0 ready (${this.getStoreValue('sg3Type')}, address ${hex4(this._address)})`);
  }

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

  // One send (lib/sg3/controller.js, setThermostat), in the background;
  // change is the count of the change it is (_changes).
  _send(kind, value, said, change) {
    const sg3 = this._sg3;
    if (!sg3 || typeof sg3.setThermostat !== 'function') {
      this.log(`${said}: not sent, no 3.0 network`);
      this._showReported(kind);
      return;
    }
    const command = kind === 'power' ? { power: value } : { setPoint: value };
    this._sending[kind] += 1;
    const sent = sg3.setThermostat(this._address, command);
    sent.catch(() => {}).finally(() => {
      this._sending[kind] -= 1;
    });
    sent.then((result) => {
      if (!result || result.superseded) return;
      if (result.ack) {
        this.log(`${said}: acknowledged by the thermostat (${result.ack.values.join(' ')})`);
        // What it acknowledged is what it last reported, until its next status.
        const { values } = result.ack;
        const reported = kind === 'power' ? { on: values[0] === 1 } : { setPoint: values[0] + (values[1] || 0) / 10 };
        if (this._status) this._status = { ...this._status, ...reported };
        else this._kept = { ...this._kept, ...(kind === 'power' ? { power: reported.on } : reported) };
        if (change !== this._changes[kind]) return;
        if (kind === 'power') this._showPower(reported.on);
        else this._set('target_temperature', reported.setPoint);
        return;
      }
      this.log(`${said}: no acknowledgement from the thermostat within 3 s, not sent again`);
      if (change === this._changes[kind]) this._showReported(kind);
    }, (err) => {
      this.log(`${said}: not sent (${err.message || err})`);
      if (change === this._changes[kind]) this._showReported(kind);
    });
  }

  _showPower(on) {
    this._set('onoff', on);
    this._set('thermostat_mode', on ? 'heat' : 'off');
  }

  // What the thermostat last reported for this kind, or before its first
  // status what Homey kept at start.
  _showReported(kind) {
    if (kind === 'power') {
      const on = this._status ? this._status.on : this._kept.power;
      if (typeof on === 'boolean') this._showPower(on);
      return;
    }
    const setPoint = this._status ? this._status.setPoint : this._kept.setPoint;
    if (reads(setPoint) && setPoint >= SET_POINT_MIN && setPoint <= SET_POINT_MAX) this._set('target_temperature', setPoint);
  }

  // null once deleted: Homey may still list the device while onDeleted runs.
  getSg3Address() {
    return this._deleted ? null : this._address;
  }

  getSg3HomeKey() {
    return this._homeKey;
  }

  // Never asked for its status and never set (app.js, deviceAddresses).
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
      if (ours) ours.on('thermostat', this._onThermostat);
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

  // Its status (lib/sg3/controller.js, 'thermostat'): shown, and logged at
  // the first one since start and when what it says changes.
  applyThermostat(status) {
    this._status = status;
    const said = `room ${degrees(status.room)}, floor ${degrees(status.floor)}, set point ${degrees(status.setPoint)}, `
      + `sensor ${status.sensor || 'not given'}, ${status.heating ? 'heating' : 'not heating'}, ${status.on ? 'on' : 'off'}`;
    if (said !== this._said) this.log(`status: ${said}${this._said === null ? ' (first since start)' : ''}`);
    this._said = said;
    this._set('onoff', status.on);
    this._set('thermostat_mode', status.on ? 'heat' : 'off');
    this._set('sg_heating', status.heating);
    if (reads(status.setPoint) && status.setPoint >= SET_POINT_MIN && status.setPoint <= SET_POINT_MAX) {
      this._set('target_temperature', status.setPoint);
    } else if (reads(status.setPoint)) {
      this.log(`set point ${degrees(status.setPoint)} not shown: outside ${SET_POINT_MIN} to ${SET_POINT_MAX}`);
    }
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

  _applyTemperatures(settings = this.getSettings()) {
    if (!this._status) return;
    const { room: roomRead, floor: floorRead } = this._status;
    const sensor = this._sensor();
    const room = reads(roomRead) && (roomRead !== 0 || sensor !== 'floor') ? roomRead : null;
    const floor = sensor !== 'room' && reads(floorRead) ? floorRead : null;
    this._set('measure_temperature', this._shownSensor(settings) === 'floor' ? floor : room);
    this._set('measure_temperature.floor', floor);
    this._set('measure_temperature.room', room);
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
    if (this._sg3) this._sg3.off('thermostat', this._onThermostat);
    this._sg3 = null;
  }
}

module.exports = SG3ThermostatDevice;
