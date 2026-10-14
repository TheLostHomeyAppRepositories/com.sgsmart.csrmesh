'use strict';

const Homey = require('homey');
const { makePacket, meshIdFromName, resolveKey } = require('./csrmesh');

// SG LEDDim data-model command, decoded from the SG app's own log:
//   [dstLo dstHi] [73] [A0 ctr] [F2 E7] [idHi idLo] [00 00] [01] [level]
// dst = 0x8001 written little-endian (01 80) = the SG data-model channel; the
// dimmer itself is selected by the 2-byte device id inside the payload.
// level is 0..100 decimal, not the CSRmesh -128..-1 lightbulb encoding.
const DEST = 0x8001;
// Homey sets onoff and dim in the same breath when the slider is dragged on a
// dark lamp. Long enough to catch both, short enough not to feel laggy.
const DIM_DEBOUNCE_MS = 250;
// Siri (through HomeKit) sends "on" and the level as two changes, mostly about
// 0.3 s apart but up to 0.84 s (measured 15.10.2026), too far apart for the
// debounce above. "On" without a level to a dimmer that is off waits this long
// for one, so the lamp does not first go back to its previous level; to a
// dimmer that is on, it sends nothing. Off and levels are not held.
const ON_WAIT_MS = 800;
const MCP_OPCODE = 0x73;
const SG_SUBCODE = 0xa0;
const SG_VENDOR = [0xf2, 0xe7];
// After a command the dimmer fades (from 30 % when it was off) and reports
// the levels on the way. Those reports are ignored until it is within this
// much of the target, for at most STATUS_SETTLE_MS.
const STATUS_SAME_PCT = 2;
const STATUS_SETTLE_MS = 5000;
// A room slider in the Homey app sets the group and each dimmer at once, so
// one dimmer can be asked for the same level twice. A level that is being
// sent, or was delivered less than this long ago, is not sent again unless
// the dimmer has reported another level since.
const SAME_LEVEL_MS = 2000;

class SGMeshDevice extends Homey.Device {
  _infoLog(...args) {
    super.log(...args);
  }

  async onInit() {
    // A dimmer that is off reports dim 0, so the stored value cannot seed the
    // level to restore on the next "on": Math.max(1, 0) would command 1%, well
    // under the dimmer's own 10% floor, and the light would look dead.
    const storedDim = this.getCapabilityValue('dim');
    this._lastDim = (typeof storedDim === 'number' && storedDim > 0) ? storedDim : 1;

    this._target = null;        // latest requested percent (coalesced)
    this._busy = false;
    this._lastAppliedLevel = null;
    this._sentLevel = null;     // last level delivered, until the dimmer reports another
    this._sentAt = 0;
    this._inFlight = null;      // the send under way: { level, delivered, changed }

    await this.setAvailable().catch(() => {});

    // onoff and dim must be coupled and debounced, as the SDK's light guidance
    // requires: dragging the slider on a dark lamp makes Homey set both at once,
    // and two separate listeners would race to send conflicting levels for the
    // same gesture. One listener turns each gesture into exactly one level.
    // Returns to Homey immediately; the BLE burst runs in the background so the
    // 10 s capability timeout can never fire on a slow mesh.
    this.registerMultipleCapabilityListener(['onoff', 'dim'], async (values) => {
      this._onCapabilities(values);
    }, DIM_DEBOUNCE_MS);

    this._infoLog(`dimmer ready (mesh id 0x${this.getMeshId().toString(16).padStart(4, '0')})`);
    this.homey.app.dimmersChanged();
  }

  async onAdded() {
    this.homey.app.dimmersChanged();
  }

  async onDeleted() {
    if (this._onWaitTimer) this.homey.clearTimeout(this._onWaitTimer);
    this.homey.app.dimmersChanged();
  }

  // One gesture from Homey, after the debounce. Logs how long after the
  // previous one it came, so the gap between Siri's "on" and level shows.
  _onCapabilities(values) {
    const now = Date.now();
    const gap = this._capabilitiesAt ? ` (+${now - this._capabilitiesAt}ms)` : '';
    this._capabilitiesAt = now;
    this._infoLog(`capability in: ${Object.entries(values).map(([k, v]) => `${k}=${v}`).join(' ')}${gap}`);

    if (this._onWaitTimer) {
      this.homey.clearTimeout(this._onWaitTimer);
      this._onWaitTimer = null;
    }
    if (values.onoff === true && typeof values.dim !== 'number') {
      // Already on, as the group treats a lit dimmer: nothing to send. This
      // also covers the second half of a level and "on" from Siri.
      if (typeof this._lastAppliedLevel === 'number' && this._lastAppliedLevel > 0) {
        this._skipLog(this._lastAppliedLevel, '"on" while already on');
        return;
      }
      const pct = this._levelFor(values);
      // Shown now, as before: the Homey app reads the tile back when this
      // listener answers.
      this.setCapabilityValue('dim', pct / 100).catch(() => {});
      this._onWaitTimer = this.homey.setTimeout(() => {
        this._onWaitTimer = null;
        this._request(pct);
      }, ON_WAIT_MS);
      return;
    }
    this._request(this._levelFor(values));
  }

  // The mesh id is normally carried in the @NDxxxx advertisement name captured
  // during pairing; the setting is a manual fallback.
  getMeshId() {
    const fromName = meshIdFromName(this.getStoreValue('localName'));
    if (fromName !== null) return fromName;
    return Number(this.getSettings().object_id || 0) & 0xffff;
  }

  getNetworkKey() {
    return resolveKey(this.getSettings());
  }

  applyMeshStatus(idHex, level) {
    if (parseInt(idHex, 16) !== this.getMeshId()) return;
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    // Another level than the one just delivered (the wall switch, or the fade
    // on its way): the same level again is a change, so it will be sent.
    if (this._sentLevel !== null && (Math.abs(pct - this._sentLevel) > STATUS_SAME_PCT
      || (pct > 0) !== (this._sentLevel > 0))) this._sentLevel = null;
    // Just after a command, the dimmer is still on its way to the target.
    if (this._commandedAt && Date.now() - this._commandedAt < STATUS_SETTLE_MS
      && Math.abs(pct - this._commandedLevel) > STATUS_SAME_PCT) return;
    // The dimmers round to their own steps (one reports 21 for 20); within
    // 2 % of what Homey shows, and still on or still off, it is the same level.
    const shown = this._lastAppliedLevel;
    if (typeof shown === 'number' && Math.abs(pct - shown) <= STATUS_SAME_PCT
      && (pct > 0) === (shown > 0)) return;
    this._applyLevel(pct);
  }

  _applyLevel(level) {
    const pct = Math.max(0, Math.min(100, Math.round(level)));
    if (pct === this._lastAppliedLevel) return;
    this._lastAppliedLevel = pct;
    if (pct > 0) this._lastDim = pct / 100;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});
    this._infoLog(`status applied: on=${pct > 0} dim=${pct}%`);
  }

  // Turn one coupled onoff/dim change into a single 0..100 level.
  //   both set   — dragging the slider on a dark lamp: dim wins, unless the
  //                gesture explicitly asks for off.
  //   dim only   — slider on a lit lamp; 0 means off.
  //   onoff only — the power button: restore the last level the lamp was at.
  _levelFor(values) {
    const { onoff, dim } = values;
    let pct;

    if (typeof dim === 'number') {
      pct = Math.round(dim * 100);
      if (onoff === false) pct = 0;
    } else if (typeof onoff === 'boolean') {
      pct = onoff ? Math.max(1, Math.round(this._lastDim * 100)) : 0;
    } else {
      return this._lastAppliedLevel ?? 0;
    }

    pct = Math.max(0, Math.min(100, pct));
    // Never remember 0 as the level to come back to; "on" would command 1%,
    // far under the dimmer's own 10% floor, and the lamp would look dead.
    if (pct > 0) this._lastDim = pct / 100;
    return pct;
  }

  // Coalesce: keep only the newest target. While a send is running, slider
  // moves just update the target; the drain loop sends the latest and skips
  // the intermediates.
  _request(pct) {
    // Any newer request, also one from the group, replaces a held "on".
    if (this._onWaitTimer) {
      this.homey.clearTimeout(this._onWaitTimer);
      this._onWaitTimer = null;
    }
    if (this._busy && this._target === pct) this._skipLog(pct, 'same level already waiting');
    // Another level asked for meanwhile (off and on again while a send keeps
    // failing): the level the user ends on is a new request, not a repeat.
    if (this._inFlight && pct !== this._inFlight.level) this._inFlight.changed = true;
    this._target = pct;
    this._commandedLevel = pct;
    this._commandedAt = Date.now();

    // Reflect the gesture in Homey now, not from inside the send. A send that
    // is still retrying keeps _drain() awaiting and _busy true, so every later
    // gesture would otherwise be swallowed here in silence: no log, no tile
    // update, until the mesh recovers minutes later. The newest request is the
    // truth the user is looking at; a status poll corrects it if the dimmer
    // ends up somewhere else.
    this._lastAppliedLevel = pct;
    this.setCapabilityValue('onoff', pct > 0).catch(() => {});
    this.setCapabilityValue('dim', pct / 100).catch(() => {});

    if (!this._busy) this._drain();
  }

  async _drain() {
    this._busy = true;
    try {
      // The send that has just finished; a target found after it came in
      // while that send was under way.
      let last = null;
      while (this._target !== null) {
        const pct = this._target;
        this._target = null;
        if (this._alreadySent(pct, last)) continue;
        last = { level: pct, delivered: false, changed: false };
        this._inFlight = last;
        try {
          last.delivered = await this._sendOnce(pct);
        } catch (err) {
          this.error(`send failed: ${err.message || err}`);
        }
      }
    } finally {
      this._busy = false;
      this._inFlight = null;
    }
  }

  // A request for the level that was being sent when it came in is skipped
  // whatever that send's outcome: a failed send has had its retries already.
  _alreadySent(pct, last) {
    if (last && pct === last.level && !last.changed) {
      this._skipLog(pct, `same level was being sent (${last.delivered ? 'delivered' : 'not delivered'})`);
      return true;
    }
    const ago = Date.now() - this._sentAt;
    // A clock that stepped back must not stretch the window.
    if (pct !== this._sentLevel || ago < 0 || ago >= SAME_LEVEL_MS) return false;
    this._skipLog(pct, `same level delivered ${ago}ms ago`);
    return true;
  }

  _skipLog(pct, why) {
    this._infoLog(`command id=0x${this.getMeshId().toString(16).padStart(4, '0')} level=${pct} skipped: ${why}`);
  }

  async _sendOnce(pct) {
    const key = this.getNetworkKey();
    const id = this.getMeshId();
    const level = Math.max(0, Math.min(100, Math.round(pct)));

    // Exactly one command per capability change. The Gen1 counter byte is a
    // local rolling value, seeded from the app-wide sequence on first use.
    if (!Number.isInteger(this._gen1Seq)) {
      this._gen1Seq = this.homey.app.nextSeq() & 0xff;
    } else {
      this._gen1Seq = (this._gen1Seq + 1) & 0xff;
    }
    const ctr = this._gen1Seq;

    const data = Buffer.from([
      DEST & 0xff, (DEST >> 8) & 0xff,
      MCP_OPCODE,
      SG_SUBCODE, ctr,
      SG_VENDOR[0], SG_VENDOR[1],
      (id >> 8) & 0xff, id & 0xff,
      0x00, 0x00, 0x01, level,
    ]);

    const seq = this.homey.app.nextSeq();
    const packet = makePacket(key, seq, data);

    this._infoLog(
      `command id=0x${id.toString(16).padStart(4, '0')} level=${level} ` +
      `seq=0x${seq.toString(16).padStart(6, '0')}`
    );

    // Homey already shows this level: _request() set it the moment the gesture
    // arrived, so the tile never waits on the mesh.
    this._sentLevel = null;
    const result = await this.homey.app.bridge.send(packet, { key: `device:${id.toString(16)}`, level });
    if (!result || !result.ok) return false;
    this._sentLevel = level;
    this._sentAt = Date.now();
    return true;
  }
}

module.exports = SGMeshDevice;
