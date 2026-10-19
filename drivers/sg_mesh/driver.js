'use strict';

const Homey = require('homey');
const { NODE_NAME } = require('../../lib/csrmesh');

// 16-bit form of a service UUID as Homey gives it (with or without dashes).
function shortUuid(uuid) {
  const s = String(uuid || '').toLowerCase().replace(/-/g, '');
  return s.length === 32 ? s.slice(4, 8) : s;
}

function serviceDataList(adv) {
  if (Array.isArray(adv.serviceData)) return adv.serviceData;
  return Object.entries(adv.serviceData || {}).map(([uuid, data]) => ({ uuid, data }));
}

function hexOf(data) {
  if (Buffer.isBuffer(data)) return data.toString('hex');
  if (typeof data === 'string') return data.toLowerCase();
  try { return Buffer.from(data || []).toString('hex'); } catch (err) { return ''; }
}

// SG nodes send service data 02FA starting with 10 f2 e7 (f2e7 is also in
// SG's mesh packets), named or not.
function hasSgData(adv) {
  return serviceDataList(adv).some((s) => shortUuid(s.uuid) === '02fa' && hexOf(s.data).startsWith('10f2e7'));
}

function isEmpty(adv) {
  return !String(adv.localName || '').trim()
    && !(adv.serviceUuids || []).length
    && !serviceDataList(adv).length
    && !hexOf(adv.manufacturerData);
}

// A peripheral seen more than once counts once, with what any sighting showed.
function scanPeripherals(advertisements) {
  const peripherals = new Map();
  for (const adv of advertisements) {
    const uuids = (adv.serviceUuids || []).map(shortUuid);
    const p = peripherals.get(adv.uuid) || { empty: true, connectable: false, rssi: -Infinity };
    p.named = p.named || NODE_NAME.test(String(adv.localName || '').trim());
    p.sg = p.sg || p.named || hasSgData(adv);
    p.csrmesh = p.csrmesh || uuids.includes('fef1');
    p.sigMesh = p.sigMesh || uuids.some((u) => u === '1827' || u === '1828');
    p.connectable = p.connectable || adv.connectable !== false;
    p.empty = p.empty && isEmpty(adv);
    const rssi = Number(adv.rssi);
    if (Number.isFinite(rssi) && rssi < 0) p.rssi = Math.max(p.rssi, rssi);
    const data02fa = serviceDataList(adv).find((d) => shortUuid(d.uuid) === '02fa');
    if (data02fa && !p.data02fa) p.data02fa = hexOf(data02fa.data).slice(0, 32);
    peripherals.set(adv.uuid, p);
  }
  return peripherals;
}

// One log line per pairing search: counts only, no addresses or node names.
function scanSummary(peripherals, advertisements, candidates, addedIds, seconds) {
  const all = [...peripherals.values()];
  const sg = all.filter((p) => p.sg);
  const notConnectable = sg.filter((p) => !p.connectable).length;
  const withoutName = sg.filter((p) => p.connectable && !p.named).length;
  const withName = sg.length - notConnectable - withoutName;
  const added = candidates.filter(([localName]) => addedIds.has(localName)).length;
  const rssi = sg.map((p) => p.rssi).filter(Number.isFinite);
  const signal = rssi.length ? ` SG signal ${Math.min(...rssi)} to ${Math.max(...rssi)} dB.` : '';
  return `pair: scan ${seconds.toFixed(1)} s, ${advertisements.length} advertisement(s).`
    + ` Mesh: ${all.filter((p) => p.csrmesh).length} CSRmesh, ${all.filter((p) => p.sigMesh).length} Bluetooth Mesh.`
    + ` SG: ${sg.length} (${withName} with name, ${withoutName} without name, ${notConnectable} not connectable),`
    + ` ${all.filter((p) => p.empty).length} empty.`
    + ` Listed ${candidates.length - added}, already added ${added}.${signal}`;
}

// The 02FA service data of each SG node, strongest first and numbered, with
// no address or name: it tells SG device types apart (both of ours send
// 10f2e71101).
function sgNodesLine(peripherals) {
  const strength = (p) => (Number.isFinite(p.rssi) ? p.rssi : -999);
  const sg = [...peripherals.values()].filter((p) => p.sg).sort((a, b) => strength(b) - strength(a));
  if (!sg.length) return 'pair: SG nodes: none';
  const shown = sg.slice(0, 10).map((p, i) => `${i + 1}: 02FA ${p.data02fa || '-'}, `
    + `${Number.isFinite(p.rssi) ? `${p.rssi} dB` : 'no signal'}, `
    + `${p.connectable ? (p.named ? 'named' : 'no name') : 'not connectable'}`);
  return `pair: SG nodes: ${shown.join('; ')}${sg.length > 10 ? `; and ${sg.length - 10} more` : ''}`;
}

class SGMeshDriver extends Homey.Driver {
  async onPairListDevices() {
    const started = Date.now();
    let advertisements;
    try {
      advertisements = await this.homey.ble.discover();
    } catch (err) {
      this.error(`pair: scan failed after ${((Date.now() - started) / 1000).toFixed(1)} s: ${err.message || err}`);
      throw err;
    }
    const seconds = (Date.now() - started) / 1000;

    // A mesh node repeats its advertisement; keep the strongest sighting of each.
    const byName = new Map();
    for (const adv of advertisements) {
      const localName = String(adv.localName || '').trim().toUpperCase();
      if (!NODE_NAME.test(localName)) continue;
      if (adv.connectable === false) continue;

      const previous = byName.get(localName);
      if (!previous || Number(adv.rssi ?? -999) > Number(previous.rssi ?? -999)) {
        byName.set(localName, adv);
      }
    }

    const candidates = [...byName.entries()]
      .sort(([, a], [, b]) => Number(b.rssi ?? -999) - Number(a.rssi ?? -999));

    const addedIds = new Set(this.getDevices().map((device) => String((device.getData() || {}).id || '').toUpperCase()));
    const peripherals = scanPeripherals(advertisements);
    this.log(scanSummary(peripherals, advertisements, candidates, addedIds, seconds));
    this.log(sgNodesLine(peripherals));

    if (!candidates.length) {
      throw new Error(this.homey.__('pair.noDimmersFound'));
    }
    if (candidates.every(([localName]) => addedIds.has(localName))) {
      throw new Error(this.homey.__('pair.allAlreadyAdded'));
    }

    // Devices are listed under the name they broadcast; the user renames them
    // in Homey after pairing. data.id is that stable broadcast identity, which
    // is also what Homey uses to filter out already-paired devices.
    return candidates.map(([localName, adv]) => ({
      name: localName,
      data: { id: localName },
      store: {
        peripheralUuid: adv.uuid,
        address: adv.address || '',
        localName,
      },
    }));
  }
}

module.exports = SGMeshDriver;
