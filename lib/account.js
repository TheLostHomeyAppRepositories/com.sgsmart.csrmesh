'use strict';

const { DEFAULT_PASSPHRASE } = require('./csrmesh');
const { LISTEN_MARGIN_MS, STATUS_LISTEN_MS } = require('./CsrNetwork');
const { csrProductForType, familyForType } = require('./sgProducts');

// The SG account in the app's settings (2.7.0). The settings page sends the
// e-mail and password through the app's API (api.js); they go to the account
// module (below) and are dropped. Kept, under one app setting the page never
// reads, is per home: the CSR network passphrase when it is not 1234, the two
// SG Smart 3.0 keys (kept for later, not used yet), the location id and the
// devices (mesh id, type, and the name the user gave it in the SG app, as
// cleanName leaves it). The page gets only the summary. Pairing takes a
// device's name as the name it suggests (nameFor); a device added in Homey
// keeps its name in Homey, also after "Forget SG account".
//
// After a fetch every device is checked once, for "X of Y answer": a later
// CSRmesh device gets one FF04 (lib/CsrNetwork.js, requestStatus), never
// again in that check, and any frame from its mesh id counts as an answer; a
// first generation dimmer counts when the app has heard its status lately,
// and nothing is sent to it; an SG Smart 3.0 device is kept, not asked. An
// FF04 needs a location id: the device's own, or else its home's from the
// account; without either the device is not asked and shows as unknown.
// "Forget SG account" removes all of it, and the devices fall back to their
// own passphrase or 1234 (lib/csrmesh.js, resolveKey).
//
// Nothing here logs the e-mail, a password, a key or a name: counts only.
//
// The account module, which logs in and fetches, is lib/sky/: a private
// module in its own repository (sg-leddim-account), not in this one. It gives
// { interfaceVersion, fetchHomes }. fetchHomes(email, password, { log })
// gives { homes, loggedOut }, each home { passphrase, netKey, appKey,
// locationId, devices: [{ meshId, type, name }] }, values null when missing
// (interface 1 has no name: it counts as missing); it
// fails with an error whose code starts with SG_CLOUD_ and whose message
// holds no value. It keeps nothing and logs counts only, through log. Without
// the module, with another interfaceVersion, or when it does not load, the
// account is not available in this build, and the rest of the app is as
// without an account.

const SETTING = 'sgAccount';
const INTERFACE_VERSIONS = [1, 2];
// A name from the account longer than this, after cleanName, is not used.
const NAME_MAX = 64;
// Our own address in the mesh: frames from it are our own messages coming back.
const OWN_ADDRESS = 0x8000;
// After the last FF04, how long the answers may take.
const ANSWER_MS = STATUS_LISTEN_MS + LISTEN_MARGIN_MS;

const hex4 = (value) => `0x${value.toString(16).padStart(4, '0')}`;

// The account module's fetchHomes, or null, with why for the log. load is
// for the tests.
function loadAccountModule(load = () => require('./sky')) {
  let loaded;
  try {
    loaded = load();
  } catch (err) {
    const missing = err && err.code === 'MODULE_NOT_FOUND' && String(err.message).startsWith("Cannot find module './sky'");
    return { fetch: null, why: missing ? 'not in this build' : `did not load (${(err && err.name) || 'error'})` };
  }
  if (!loaded || !INTERFACE_VERSIONS.includes(loaded.interfaceVersion)) {
    return { fetch: null, why: `has interface ${loaded && loaded.interfaceVersion} where ${INTERFACE_VERSIONS.join(' or ')} is needed` };
  }
  if (typeof loaded.fetchHomes !== 'function') return { fetch: null, why: 'has no fetchHomes' };
  return { fetch: loaded.fetchHomes, why: null };
}

// What an error from the account module means for the settings page.
function errorKey(err) {
  const code = err && err.code;
  if (code === 'SG_CLOUD_LOGIN') return 'login';
  if (code === 'SG_CLOUD_MISSING') return 'missing';
  if (code === 'SG_CLOUD_TIMEOUT' || code === 'SG_CLOUD_NETWORK') return 'network';
  return 'other';
}

// A device's name from the account as it may be used, or null: text, with
// control characters, line breaks and tabs made spaces and invisible format
// characters (such as a right-to-left mark, but not the joiner inside an
// emoji) left out, spaces run together
// and trimmed; null when nothing is left or it is longer than NAME_MAX
// characters. Never throws.
function cleanName(value) {
  try {
    if (typeof value !== 'string') return null;
    const name = value.replace(/(?!\u200d)\p{Cf}/gu, '').replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, ' ').replace(/\s+/g, ' ').trim();
    if (!name || [...name].length > NAME_MAX) return null;
    return name;
  } catch (err) {
    return null;
  }
}

// A home as kept from a fetched one: the passphrase only when it is not
// 1234, and only devices with a mesh id, each with its name cleaned.
function keptHome(home) {
  const passphrase = typeof home.passphrase === 'string' && home.passphrase.trim()
    && home.passphrase.trim() !== DEFAULT_PASSPHRASE ? home.passphrase : null;
  return {
    passphrase,
    netKey: home.netKey || null,
    appKey: home.appKey || null,
    locationId: Number.isInteger(home.locationId) ? home.locationId : null,
    devices: home.devices.filter((device) => Number.isInteger(device.meshId))
      .map((device) => ({ meshId: device.meshId, type: device.type, name: cleanName(device.name) })),
  };
}

class SgAccount {
  // fetch is the account module's fetchHomes, or a test's; load, for the
  // tests, loads the module instead of lib/sky/.
  constructor(app, { fetch, load } = {}) {
    this.app = app;
    this.homey = app.homey;
    if (fetch) {
      this._fetch = fetch;
    } else {
      const found = loadAccountModule(load);
      this._fetch = found.fetch;
      if (found.why) app.log(`[SG account] the account module ${found.why}: no SG account in this build`);
    }
    this._state = this._load();
    this._heardAt = new Map(); // mesh id -> when a frame from it was last heard
    this._busy = false;        // a fetch runs
    this._checking = false;    // a check runs
    this._run = 0;             // the latest fetch, check or forget
    this._timers = new Set();
  }

  _load() {
    const state = this.homey.settings.get(SETTING);
    return state && Array.isArray(state.homes) ? state : null;
  }

  _save() {
    this.homey.settings.set(SETTING, this._state);
  }

  stop() {
    this._run += 1;
    for (const timer of this._timers) this.homey.clearTimeout(timer);
    this._timers.clear();
  }

  // From MeshBridge.onFrame (app.js): a frame from this mesh id was heard.
  heard(src) {
    if (Number.isInteger(src) && src !== OWN_ADDRESS) this._heardAt.set(src, Date.now());
  }

  fetched() {
    return !!this._state;
  }

  // The account module is in this build.
  available() {
    return typeof this._fetch === 'function';
  }

  // The homes with a device of this mesh id.
  _homesWith(meshId) {
    if (!this._state || !Number.isInteger(meshId)) return [];
    return this._state.homes.filter((home) => home.devices.some((device) => device.meshId === meshId));
  }

  // The passphrase of the one home that has this mesh id, or null: also when
  // two homes have it, or that home's is 1234.
  passphraseFor(meshId) {
    const homes = this._homesWith(meshId);
    return homes.length === 1 ? homes[0].passphrase : null;
  }

  // The one passphrase other than 1234 the account has, or null when it has
  // none or several.
  onlyPassphrase() {
    if (!this._state) return null;
    const all = new Set(this._state.homes.map((home) => home.passphrase).filter(Boolean));
    return all.size === 1 ? [...all][0] : null;
  }

  // The name of this mesh id in the account (cleanName), when exactly one
  // home has it, else null.
  nameFor(meshId) {
    const homes = this._homesWith(meshId);
    if (homes.length !== 1) return null;
    const device = homes[0].devices.find((d) => d.meshId === meshId);
    return device ? cleanName(device.name) : null;
  }

  // The type of this mesh id in the account, when exactly one home has it.
  typeFor(meshId) {
    const homes = this._homesWith(meshId);
    if (homes.length !== 1) return null;
    const device = homes[0].devices.find((d) => d.meshId === meshId);
    return device ? device.type : null;
  }

  // Every device of the account, with its home's number from 1.
  devices() {
    if (!this._state) return [];
    return this._state.homes.flatMap((home, i) => home.devices.map((device) => ({ ...device, home: i + 1 })));
  }

  // Log in, fetch and keep (e-mail and password go no further than the
  // account module), then check the devices without waiting for it. Gives
  // the summary, with error ('login', 'missing', 'network', 'busy',
  // 'unavailable' or 'other') when it failed; what was kept before stays
  // then.
  async login(email, password) {
    if (!this.available()) return { ...this.summary(), error: 'unavailable' };
    if (this._busy || this._checking) return { ...this.summary(), error: 'busy' };
    this._busy = true;
    const run = ++this._run;
    try {
      let fetched;
      try {
        fetched = await this._fetch(email, password, { log: (line) => this.app.log(`[SG account] ${line}`) });
      } catch (err) {
        const safe = err && /^SG_CLOUD_/.test(err.code) ? err.message : `fetch failed (${(err && err.name) || 'error'})`;
        this.app.error(`[SG account] ${safe}`);
        return { ...this.summary(), error: errorKey(err) };
      }
      if (run !== this._run) return this.summary();
      const homes = fetched.homes.map(keptHome);
      this._state = { fetchedAt: new Date().toISOString(), homes, check: null };
      this._save();
      const left = fetched.homes.reduce((sum, home) => sum + home.devices.length, 0)
        - homes.reduce((sum, home) => sum + home.devices.length, 0);
      this.app.log(`[SG account] kept ${homes.length} home(s): passphrase other than 1234 for `
        + `${homes.filter((home) => home.passphrase).length}, 3.0 keys for ${homes.filter((home) => home.netKey && home.appKey).length}, `
        + `${homes.reduce((sum, home) => sum + home.devices.length, 0)} device(s)${left ? `, ${left} without a mesh id left out` : ''}, `
        + `${homes.reduce((sum, home) => sum + home.devices.filter((device) => device.name).length, 0)} with a name`);
      this._checking = true;
      this._check(run).catch((err) => this.app.error(`[SG account] check failed: ${err.message || err}`))
        .finally(() => { if (run === this._run) this._checking = false; });
      return this.summary();
    } finally {
      this._busy = false;
    }
  }

  // The location id for an FF04 to this mesh id, or null: the device's own
  // (from its device here, or the one its FF11 brought), else its home's from
  // the account when the homes that have this mesh id agree on one.
  _locationFor(meshId) {
    for (const device of this.app._devices()) {
      if (typeof device.getCsrMeshId !== 'function' || device.getCsrMeshId() !== meshId) continue;
      const location = device.getCsrLocationId();
      if (Number.isInteger(location) && location > 0) return location;
    }
    const node = this.app.csr && this.app.csr.nodes.get(meshId);
    if (node && Number.isInteger(node.location) && node.location > 0) return node.location;
    const homes = new Set(this._homesWith(meshId).map((home) => home.locationId).filter(Number.isInteger));
    return homes.size === 1 ? [...homes][0] : null;
  }

  _wait(ms) {
    return new Promise((resolve) => {
      const timer = this.homey.setTimeout(() => {
        this._timers.delete(timer);
        resolve();
      }, ms);
      this._timers.add(timer);
    });
  }

  // One FF04 to each later CSRmesh device of the account that has a location
  // id, one after the other and none twice, then ANSWER_MS for the answers.
  // One without a location id is not asked: unknown.
  async _check(run) {
    const startedAt = Date.now();
    const asked = [];
    const unknown = [];
    for (const meshId of new Set(this.devices().filter((device) => familyForType(device.type) === 'csr')
      .map((device) => device.meshId))) {
      if (run !== this._run) return;
      const location = this._locationFor(meshId);
      if (location === null) {
        unknown.push(meshId);
        continue;
      }
      asked.push(meshId);
      try {
        await this.app.csr.requestStatus(meshId, location);
      } catch (err) {
        this.app.error(`[SG account] FF04 to ${hex4(meshId)} failed: ${err.message || err}`);
      }
    }
    if (asked.length) await this._wait(ANSWER_MS);
    if (run !== this._run || !this._state) return;
    const answers = (device) => {
      const family = familyForType(device.type);
      if (family === 'gen1') return typeof this.app.recentlyHeard === 'function' && this.app.recentlyHeard(device.meshId);
      if (family === 'csr') return asked.includes(device.meshId) && (this._heardAt.get(device.meshId) || 0) >= startedAt;
      return false;
    };
    this._state.check = {
      at: new Date().toISOString(),
      answering: this._state.homes.map((home) => home.devices.filter(answers).map((device) => device.meshId)),
      unknown,
    };
    this._save();
    const isUnknown = (device) => familyForType(device.type) === 'csr' && unknown.includes(device.meshId);
    const counted = this.devices().filter((device) => familyForType(device.type) !== 'sg3' && !isUnknown(device));
    const answering = this._state.check.answering.reduce((sum, ids) => sum + ids.length, 0);
    const unknownCount = this.devices().filter(isUnknown).length;
    this.app.log(`[SG account] check: ${answering} of ${counted.length} answer, ${asked.length} FF04 sent, `
      + `${unknownCount} unknown (no location id), `
      + `${this.devices().filter((device) => familyForType(device.type) === 'sg3').length} SG Smart 3.0 not asked`);
  }

  // Remove everything kept from the account. A fetch or check that still
  // runs keeps nothing.
  forget() {
    this._run += 1;
    this._checking = false;
    for (const timer of this._timers) this.homey.clearTimeout(timer);
    this._timers.clear();
    this._state = null;
    this._heardAt.clear();
    if (typeof this.homey.settings.unset === 'function') this.homey.settings.unset(SETTING);
    else this.homey.settings.set(SETTING, null);
    this.app.log('[SG account] forgotten: the devices use their own passphrase or 1234');
    return this.summary();
  }

  // A device of the account by name for the page: its name in Homey when it
  // is added here, else its product and address.
  _shown(device) {
    for (const added of this.app._devices()) {
      const meshId = typeof added.getCsrMeshId === 'function' ? added.getCsrMeshId()
        : typeof added.getMeshId === 'function' ? added.getMeshId() : null;
      if (meshId === device.meshId) return { name: added.getName() };
    }
    const family = familyForType(device.type);
    const product = family === 'gen1' ? 'LEDDim Smart' : family === 'sg3' ? 'SG Smart 3.0'
      : (csrProductForType(device.type) || {}).name || null;
    return { product, type: device.type, address: device.meshId.toString(16).toUpperCase().padStart(4, '0') };
  }

  // What the settings page shows.
  summary() {
    const available = this.available();
    if (!this._state) return { available, fetched: false, checking: false, homes: [] };
    const { check } = this._state;
    return {
      available,
      fetched: true,
      fetchedAt: this._state.fetchedAt,
      checking: this._checking,
      homes: this._state.homes.map((home, i) => {
        const sg3 = home.devices.filter((device) => familyForType(device.type) === 'sg3').length;
        const unknownIds = new Set(check && Array.isArray(check.unknown) ? check.unknown : []);
        const unknown = home.devices.filter((device) => familyForType(device.type) === 'csr' && unknownIds.has(device.meshId));
        const counted = home.devices.filter((device) => familyForType(device.type) !== 'sg3' && !unknown.includes(device));
        const answering = new Set(check && check.answering[i] ? check.answering[i] : []);
        return {
          number: i + 1,
          devices: home.devices.length,
          passphrase: !!home.passphrase,
          sg3,
          checked: !!check,
          answering: counted.filter((device) => answering.has(device.meshId)).length,
          total: counted.length,
          quiet: check ? counted.filter((device) => !answering.has(device.meshId)).map((device) => this._shown(device)) : [],
          unknown: unknown.map((device) => this._shown(device)),
        };
      }),
    };
  }
}

module.exports = {
  INTERFACE_VERSIONS, NAME_MAX, SETTING, SgAccount, cleanName, errorKey, loadAccountModule,
};
