'use strict';

const SG3Driver = require('../sg3_dimmer/driver');

// HeatReg Smart 3.0: the SG Smart 3.0 thermostats of the 3.0 network whose
// keys the SG account kept, found and listed as the 3.0 dimmers are
// (drivers/sg3_dimmer), from the account and the pairing scan. The scan
// knows one by its type byte 0xB4 (lib/sg3/advert.js: assumed, not seen on
// a real thermostat). The device is
// lib/SG3ThermostatDevice.js. The cards for heating are the app's, shared
// with HeatReg Smart (.homeycompose/flow, sg_heating_true, sg_heating_false
// and sg_heating_is, whose run listener drivers/sg_thermostat/driver.js
// registers for both).
const LISTING = Object.freeze({
  driver: 'sg3_thermostat',
  capabilities: ['target_temperature', 'measure_temperature', 'measure_temperature.floor', 'measure_temperature.room',
    'onoff', 'thermostat_mode', 'sg_heating', 'measure_power'],
});

class SG3ThermostatDriver extends SG3Driver {
  _pairing() {
    return {
      listing: LISTING, what: 'HeatReg Smart 3.0', none: 'pair.sg3Thermostat.none', allAdded: 'pair.sg3Thermostat.allAdded',
    };
  }
}

module.exports = SG3ThermostatDriver;
module.exports.LISTING = LISTING;
