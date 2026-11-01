'use strict';

const {
  ADDR_BROADCAST, OP_EXT_LEVEL, OP_EXT_NAME, OP_EXT_NAME_GET, OP_EXT_STATUS, OP_EXT_STATUS_GET, opcodeValue,
} = require('../sgProtocol');
const { csrProductForName } = require('../sgProducts');

// The fake devices themselves (lib/fake/index.js): their state, and what
// they answer. An answer is built in the format lib/sgProtocol.js reads, so
// it goes through the same reading as a real device's. Those formats are
// this app's own and assumed: a fake answer shows that the app reads what it
// expects, not that a real device sends it.

const LEVEL = opcodeValue(OP_EXT_LEVEL);
const STATUS_GET = opcodeValue(OP_EXT_STATUS_GET);
const STATUS = opcodeValue(OP_EXT_STATUS);
const NAME_GET = opcodeValue(OP_EXT_NAME_GET);
const NAME = opcodeValue(OP_EXT_NAME);
// A fake device's firmware, in FF05.
const FIRMWARE = [0x01, 0x00];
// An FF03 whose tid is not newer than the last one taken within this many
// whole seconds is dropped, as a real device is assumed to (lib/SGCsrDevice.js).
const TID_RESET_S = 10;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;
const locationBytes = (location) => [(location >> 8) & 0xff, location & 0xff];

class FakeNode {
  constructor({ prefix, meshId, location, now = () => Date.now() }) {
    this.meshId = meshId;
    this.location = location;
    this.name = `${prefix}${meshId.toString(16).toUpperCase().padStart(4, '0')}`;
    this.product = csrProductForName(this.name);
    this.now = now;
    // Ordered with "silent": it answers nothing until "answer".
    this.silent = false;
    // What it did not take, for the log (lib/fake/bridge.js takes them).
    this.notes = [];
  }

  toString() {
    return `${this.name} (${hex4(this.meshId)})`;
  }

  // A message on the fake radio ({ dst, opcode, data }): the answers, as
  // [{ opcode, data }], or none. FF10 to everyone with 00 00 or its own
  // location id gets FF11; anything else must be to its mesh id, with its
  // location id.
  receive({ dst, opcode, data }) {
    if (this.silent) return [];
    if (dst === ADDR_BROADCAST && opcode === NAME_GET) {
      const asked = data.length >= 2 ? data.readUInt16BE(0) : 0;
      return asked === 0 || asked === this.location ? [this.nameMessage()] : [];
    }
    if (dst !== this.meshId || data.length < 2 || data.readUInt16BE(0) !== this.location) return [];
    return this.command(opcode, data);
  }

  // FF11: location id, the six characters after @, the number of resets.
  nameMessage() {
    return { opcode: NAME, data: Buffer.from([...locationBytes(this.location), ...Buffer.from(this.name.slice(1), 'latin1'), 0]) };
  }

  command() {
    return [];
  }

  // An order (lib/fake/index.js): what it sends by itself now, as
  // [{ opcode, data }], or null when this node does not know the order.
  order(event) {
    if (event === 'silent') {
      this.silent = true;
      return [];
    }
    if (event === 'answer') {
      this.silent = false;
      return [];
    }
    if (event === 'name') return [this.nameMessage()];
    return null;
  }
}

// A Pill or a rotary dimmer after the first generation, with dimming or with
// on and off alone, and with a white value when the product has one.
class FakeLight extends FakeNode {
  constructor(options) {
    super(options);
    this.on = false;
    this.level = 50;
    this.white = 0;
    this.number = 0;
    this._tid = null;
    this._tidAt = 0;
  }

  get dimmable() {
    return this.product.kind === 'dimmable';
  }

  command(opcode, data) {
    if (opcode === STATUS_GET) return [this.status()];
    if (opcode !== LEVEL || data.length < 6) return [];
    const tid = data.readUInt16LE(4);
    const seconds = Math.floor((this.now() - this._tidAt) / 1000);
    if (this._tid !== null && seconds <= TID_RESET_S && tid <= this._tid) {
      this.notes.push(`FF03 tid=${tid} dropped: not newer than ${this._tid} within ${TID_RESET_S} s`);
      return [];
    }
    this._tid = tid;
    this._tidAt = this.now();
    this.on = data[2] !== 0;
    if (this.on && this.dimmable && data[3] >= 1 && data[3] <= 100) this.level = data[3];
    // White 0 means none set.
    if (this.product.tunableWhite && data.length >= 7 && data[6] > 0) this.white = data[6];
    return [this.status()];
  }

  // FF05: location id, power, level, a number one up each time, firmware,
  // and the white value and flags for a product that has white.
  status() {
    this.number = (this.number + 1) & 0xff;
    const bytes = [...locationBytes(this.location), this.on ? 1 : 0, this.on && this.dimmable ? this.level : 0,
      this.number, ...FIRMWARE];
    if (this.product.tunableWhite) bytes.push(this.white, 0);
    return { opcode: STATUS, data: Buffer.from(bytes) };
  }

  // Changed on the device itself: "on", "off", "level <1..100>", "white
  // <1..255>". Its status goes out by itself.
  order(event, value) {
    const known = super.order(event);
    if (known) return known;
    const number = Number(value);
    if (event === 'on' || event === 'off') {
      this.on = event === 'on';
    } else if (event === 'level' && this.dimmable && Number.isInteger(number) && number >= 1 && number <= 100) {
      this.on = true;
      this.level = number;
    } else if (event === 'white' && this.product.tunableWhite && Number.isInteger(number) && number >= 1 && number <= 255) {
      this.white = number;
    } else {
      return null;
    }
    return [this.status()];
  }
}

module.exports = { FakeLight, FakeNode, TID_RESET_S };
