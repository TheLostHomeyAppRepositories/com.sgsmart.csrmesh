'use strict';

const Homey = require('homey');
const { sg3CanBeBridge } = require('./sgProducts');
const { parseSg3Id } = require('./SG3Device');

// HeatReg Smart 3.0 (type 3021), the device of the driver HeatReg Smart 3.0
// (drivers/sg3_thermostat). Its id is "sig:<home key>:<address>", as a 3.0
// dimmer's (lib/SG3Device.js); its keys and the link are the app's (app.js,
// sg3, and lib/sg3/controller.js).
//
// Read only, for now: it shows the status the thermostat sends by itself
// on a link that is up (lib/sg3/controller.js, 'thermostat'; the format is
// assumed, see lib/sg3/protocol.js, parseThermostatStatus). Nothing is sent
// to it: it is never asked for its status (sg3ListensOnly, app.js), and a
// change from Homey (the set point, on and off) is refused before anything
// is sent. After a start the values Homey kept are shown until its first
// status. A link is opened for the 3.0 dimmers in Homey only; without one,
// there is no link, and nothing is heard from it.
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
// A change of these from Homey is refused (onInit); Homey then shows what it had.
const READ_ONLY_CAPABILITIES = ['target_temperature', 'onoff', 'thermostat_mode'];

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
    for (const capability of READ_ONLY_CAPABILITIES) {
      this.registerCapabilityListener(capability, async (value) => {
        this.log(`${capability}=${value} from Homey refused: nothing is sent to it in this version`);
        throw new Error(this.homey.__('device.sg3ThermostatReadOnly'));
      });
    }
    await this.updateSg3();
    const { app } = this.homey;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
    this.log(`HeatReg Smart 3.0 ready (${this.getStoreValue('sg3Type')}, address ${hex4(this._address)}), read only`);
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
    this._detach();
    const { app } = this.homey;
    if (app && typeof app.sg3DevicesChanged === 'function') app.sg3DevicesChanged();
  }

  async onUninit() {
    this._detach();
  }

  _detach() {
    if (this._sg3) this._sg3.off('thermostat', this._onThermostat);
    this._sg3 = null;
  }
}

module.exports = SG3ThermostatDevice;
