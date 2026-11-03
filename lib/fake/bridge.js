'use strict';

const { decryptPayload, verifyPacket } = require('../csrmesh');
const { ADDR_APP, extData, parseExt } = require('../sgProtocol');

// The radio of the fake devices, in place of lib/MeshBridge.js for the fake
// network (lib/fake/index.js): a packet that bridge.send would write is read
// with the fake network's key and goes to every fake device, and their
// answers come back ANSWER_MS later through the fake network's CsrNetwork
// (handleFrame), as a real device's come through MeshBridge. Nothing here
// touches Homey's Bluetooth.

const ANSWER_MS = 2000;
// What this app never sends, by the two bytes after the destination, and
// what each is assumed to change in a device:
//   8100                  a node's network settings
//   7313                  a first generation dimmer's place in the network
//   EF10, EF11            the opcodes the nodes use
//   FF0F                  a device's location id
//   FF28                  a device's place in the network
//   FFAA                  the bridge
//   FF12, FF52            a plug's own countdown (FF12 also a switch's sleep)
//   FF13 to FF17          a switch's buttons
//   FF1E                  a relay's pulse mode
//   FF39                  a plug's mode
//   FF51, FF00, FF5A      a schedule
//   FF40, FF3F, FF41      a thermostat's settings, presets, schedule and lock
//   FF5B, FF43            a thermostat's floor limit and display
//   FF0A                  a scene: the devices that keep it go to its level
//   FF33                  a light's colour temperature (white value)
//   FF47                  whether an on/off device takes an external push
//                         button
//   FF29, FF2A            a dimmer's trim: its lowest and highest level
//   FF48                  a dimmer's fading and dimming speed
//   FF4B                  a dimmer's master group
//   FF36                  a light's circadian rhythm
//   FF81                  a light's colour (RGB and RGBW)
// test/never-sent.test.js checks that nothing in the app builds them; the
// fake radio refuses them as well, so no fake device is ever told one.
const REFUSED = [
  '8100', '7313', 'ef10', 'ef11', 'ff0f', 'ff28', 'ffaa', 'ff12', 'ff52', 'ff13', 'ff14', 'ff15', 'ff16', 'ff17',
  'ff1e', 'ff39', 'ff51', 'ff00', 'ff5a', 'ff40', 'ff3f', 'ff41', 'ff5b', 'ff43',
  'ff0a', 'ff33', 'ff47', 'ff29', 'ff2a', 'ff48', 'ff4b', 'ff36', 'ff81',
];

class FakeBridge {
  constructor(network) {
    this.network = network;
    // What CsrNetwork reads of a bridge: no pairing scan ever has this radio.
    this._scanPauses = 0;
    // Every message the fake devices got, { dst, opcode, data }, and every
    // one refused, { dst, opcode }, for the tests.
    this.heard = [];
    this.refused = [];
  }

  // The link never listens: the answers come by themselves.
  listenLeftMs() {
    return 0;
  }

  async send(packet, meta = {}) {
    const key = this.network.getNetworkKey();
    if (!packet || packet.length < 18 || !verifyPacket(key, packet)) {
      this.network.log(`fake radio: ${meta.key || 'a packet'} not read: not this network's key`);
      return { ok: true };
    }
    const plain = decryptPayload(key, packet.subarray(0, 3), packet.subarray(3, 5), packet.subarray(5, packet.length - 9));
    const opcode = plain.length >= 4 ? plain.subarray(2, 4).toString('hex') : '';
    if (REFUSED.includes(opcode)) {
      const dst = plain.readUInt16LE(0);
      this.refused.push({ dst, opcode });
      this.network.log(`fake radio: ${opcode.toUpperCase()} to 0x${dst.toString(16).padStart(4, '0')} refused: `
        + 'this app never sends it');
      return { ok: false };
    }
    const ext = parseExt(plain);
    if (!ext) return { ok: true };
    this.heard.push(ext);
    for (const node of this.network.nodes) {
      for (const message of node.receive(ext)) this.deliver(node, message, ANSWER_MS);
      for (const note of node.notes.splice(0)) this.network.log(`fake ${node}: ${note}`);
    }
    return { ok: true };
  }

  // A message from a fake device, after ms (0: at once, for one it sends by
  // itself), to the fake network as the real ones come.
  deliver(node, { opcode, data }, ms = 0) {
    const plain = extData(ADDR_APP, [opcode >> 8, opcode & 0xff], [...data]);
    this.network.later(() => this.network.csr.handleFrame({ src: node.meshId, plain }), ms);
  }
}

module.exports = { ANSWER_MS, FakeBridge, REFUSED };
