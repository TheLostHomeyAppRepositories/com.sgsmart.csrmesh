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

class FakeBridge {
  constructor(network) {
    this.network = network;
    // What CsrNetwork reads of a bridge: no pairing scan ever has this radio.
    this._scanPauses = 0;
    // Every message the fake devices got, { dst, opcode, data }, for the tests.
    this.heard = [];
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

module.exports = { ANSWER_MS, FakeBridge };
