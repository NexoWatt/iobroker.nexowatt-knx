'use strict';

const utils = require('@iobroker/adapter-core');
const knx = require('knx');

const {
  inferCommonFromDpt,
  sanitizeIdSegment,
  coerceToKnxValue
} = require('./lib/knx-utils');

const { importEtsProject } = require('./lib/ets-import');

class NexowattKnx extends utils.Adapter {
  constructor(options = {}) {
    super({
      ...options,
      name: 'nexowatt-knx'
    });

    this.knxConnection = null;
    this.knxConnected = false;

    /** @type {Map<string, any>} relativeStateId -> knx.Datapoint */
    this.datapointsByStateId = new Map();

    /** @type {Map<string, {ga:string, dpt?:string, flags:{readFlag:boolean, writeFlag:boolean, transmitFlag:boolean, updateFlag:boolean}}>} */
    this.metaByStateId = new Map();

    /** @type {Array<{fn: () => void, descr: string}>} */
    this.txQueue = [];
    this.txTimer = null;

    this.on('ready', this.onReady.bind(this));
    this.on('stateChange', this.onStateChange.bind(this));
    this.on('message', this.onMessage.bind(this));
    this.on('unload', this.onUnload.bind(this));
  }

  // -------------------------
  // ioBroker lifecycle
  // -------------------------

  async onReady() {
    // Normalize config
    if (!this.config.gatewayPort) this.config.gatewayPort = 3671;
    if (!this.config.loglevel) this.config.loglevel = 'info';

    // Ensure info states exist (io-package.json also defines them, but this makes dev-mode robust)
    await this.setObjectNotExistsAsync('info', {
      type: 'channel',
      common: { name: 'Info' },
      native: {}
    });
    await this.setObjectNotExistsAsync('info.connection', {
      type: 'state',
      common: { name: 'Connection', type: 'boolean', role: 'indicator.connected', read: true, write: false, def: false },
      native: {}
    });
    await this.setObjectNotExistsAsync('info.etsHash', {
      type: 'state',
      common: { name: 'ETS project hash', type: 'string', role: 'text', read: true, write: false },
      native: {}
    });

    await this.setStateAsync('info.connection', false, true);

    // Import ETS project (optional)
    if (this.config.importOnStart && this.config.etsProjectFile) {
      try {
        await this.doImportEtsProject();
      } catch (e) {
        this.log.error(`ETS import failed: ${e?.message || e}`);
      }
    }

    // Apply manual datapoints from config (optional)
    try {
      await this.applyManualDatapoints();
    } catch (e) {
      this.log.error(`Applying manual datapoints failed: ${e?.message || e}`);
    }

    // Load mapping from created objects
    await this.rebuildRuntimeMapping();

    // Subscribe to state changes (commands from scripts/visualisations)
    this.subscribeStates('ga.*');

    // Connect to KNX
    this.connectKnx();
  }

  onUnload(callback) {
    try {
      if (this.txTimer) {
        clearInterval(this.txTimer);
        this.txTimer = null;
      }

      for (const dp of this.datapointsByStateId.values()) {
        try {
          dp.removeAllListeners();
        } catch {
          // ignore
        }
      }
      this.datapointsByStateId.clear();

      if (this.knxConnection) {
        this.log.info('Disconnecting KNX...');
        this.knxConnection.Disconnect(() => callback());
        return;
      }
    } catch (e) {
      // ignore
    }

    callback();
  }

  // -------------------------
  // Admin message interface
  // -------------------------

  async onMessage(obj) {
    if (!obj || !obj.command) return;

    if (obj.command === 'importEts') {
      try {
        await this.doImportEtsProject();
        await this.rebuildRuntimeMapping();
        this.sendTo(obj.from, obj.command, { ok: true }, obj.callback);
      } catch (e) {
        this.sendTo(obj.from, obj.command, { ok: false, error: e?.message || String(e) }, obj.callback);
      }
    }
  }

  // -------------------------
  // Mapping / objects
  // -------------------------

  async doImportEtsProject() {
    const fileName = String(this.config.etsProjectFile || '').trim();
    if (!fileName) throw new Error('No ETS project file configured');

    this.log.info(`Importing ETS project from ioBroker Files: ${this.name}/${fileName}`);

    const { hash, style, entries } = await importEtsProject(this, fileName, {
      gaStyleOverride: this.config.gaStyleOverride || 'auto'
    });

    await this.setStateAsync('info.etsHash', hash, true);
    this.log.info(`ETS import OK. GA style: ${style}. Entries: ${entries.length}`);

    // Create channels + states
    for (const entry of entries) {
      await this.ensureChannelsForState(entry.id);
      await this.upsertGaState(entry);
    }

    this.log.info('ETS objects created/updated.');
  }

  /**
   * Create missing channel objects for a state id like `ga.floor.room.1_2_3`.
   * @param {string} stateIdRel
   */
  async ensureChannelsForState(stateIdRel) {
    const parts = String(stateIdRel).split('.');
    if (parts.length <= 1) return;

    // all prefixes except last segment are channels
    let prefix = '';
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i];
      prefix = prefix ? `${prefix}.${seg}` : seg;

      await this.setObjectNotExistsAsync(prefix, {
        type: 'channel',
        common: { name: seg },
        native: {}
      });
    }
  }

  /**
   * Create or update a GA state.
   * @param {{id:string, name:string, ga:string, dpt?:string, flags:{readFlag:boolean, writeFlag:boolean, transmitFlag:boolean, updateFlag:boolean}, description?:string}} entry
   */
  async upsertGaState(entry) {
    const commonBase = inferCommonFromDpt(entry.dpt);

    const writeAllowed = Boolean(entry.flags?.writeFlag || entry.flags?.readFlag);

    const common = {
      name: entry.name,
      type: commonBase.type,
      role: commonBase.role,
      read: true,
      write: writeAllowed
    };

    const native = {
      ga: entry.ga,
      dpt: entry.dpt,
      flags: {
        readFlag: Boolean(entry.flags?.readFlag),
        writeFlag: Boolean(entry.flags?.writeFlag),
        transmitFlag: Boolean(entry.flags?.transmitFlag),
        updateFlag: Boolean(entry.flags?.updateFlag)
      },
      description: entry.description
    };

    await this.setObjectNotExistsAsync(entry.id, {
      type: 'state',
      common,
      native
    });

    // Keep existing states but update metadata (name/dpt/flags) on import
    await this.extendObjectAsync(entry.id, {
      common,
      native
    });
  }

  /**
   * Create states from `native.manualDatapoints`.
   */
  async applyManualDatapoints() {
    const list = Array.isArray(this.config.manualDatapoints) ? this.config.manualDatapoints : [];
    if (!list.length) return;

    await this.setObjectNotExistsAsync('ga', {
      type: 'channel',
      common: { name: 'Group addresses' },
      native: {}
    });
    await this.setObjectNotExistsAsync('ga._manual', {
      type: 'channel',
      common: { name: 'Manual' },
      native: {}
    });

    for (const dp of list) {
      const ga = String(dp.ga || '').trim();
      if (!ga) continue;

      const gaSeg = sanitizeIdSegment(ga.replace(/\//g, '_'));
      const id = `ga._manual.${gaSeg}`;

      const flags = {
        readFlag: Boolean(dp.readFlag),
        writeFlag: Boolean(dp.writeFlag),
        transmitFlag: dp.transmitFlag === undefined ? true : Boolean(dp.transmitFlag),
        updateFlag: false
      };

      await this.upsertGaState({
        id,
        name: String(dp.name || ga),
        ga,
        dpt: dp.dpt ? String(dp.dpt).trim() : undefined,
        flags
      });
    }
  }

  /**
   * Scan existing states under this adapter instance and build runtime mapping.
   */
  async rebuildRuntimeMapping() {
    this.metaByStateId.clear();

    const startkey = `${this.namespace}.ga.`;
    const endkey = `${this.namespace}.ga.\u9999`;

    const res = await this.getObjectViewAsync('system', 'state', {
      startkey,
      endkey,
      include_docs: true
    });

    const rows = res?.rows || [];

    for (const row of rows) {
      const obj = row?.doc;
      if (!obj || obj.type !== 'state') continue;

      const native = obj.native || {};
      const ga = native.ga;
      if (!ga) continue;

      const idFull = row.id;
      const idRel = idFull.startsWith(`${this.namespace}.`) ? idFull.slice(this.namespace.length + 1) : idFull;

      const flags = native.flags || {};

      this.metaByStateId.set(idRel, {
        ga: String(ga),
        dpt: native.dpt ? String(native.dpt) : undefined,
        flags: {
          readFlag: Boolean(flags.readFlag),
          writeFlag: Boolean(flags.writeFlag),
          transmitFlag: flags.transmitFlag === undefined ? true : Boolean(flags.transmitFlag),
          updateFlag: Boolean(flags.updateFlag)
        }
      });
    }

    this.log.info(`Runtime mapping loaded: ${this.metaByStateId.size} datapoints.`);
  }

  // -------------------------
  // KNX connection + datapoints
  // -------------------------

  connectKnx() {
    const ipAddr = String(this.config.gatewayIp || '').trim();
    const ipPort = Number(this.config.gatewayPort || 3671);

    if (!ipAddr) {
      this.log.error('No KNX/IP gateway IP configured.');
      return;
    }

    const conf = {
      ipAddr,
      ipPort,
      physAddr: String(this.config.physAddr || '').trim() || undefined,
      interface: String(this.config.localInterface || '').trim() || undefined,
      loglevel: String(this.config.loglevel || 'info'),
      forceTunneling: Boolean(this.config.forceTunneling),
      localEchoInTunneling: Boolean(this.config.localEcho),
      minimumDelay: Number(this.config.minimumDelayMs || 0) || undefined,
      handlers: {
        connected: () => this.onKnxConnected(),
        disconnected: () => this.onKnxDisconnected(),
        error: (err) => this.onKnxError(err)
      }
    };

    this.log.info(`Connecting to KNX/IP ${ipAddr}:${ipPort} ...`);

    try {
      this.knxConnection = new knx.Connection(conf);
    } catch (e) {
      this.log.error(`KNX connection init failed: ${e?.message || e}`);
      this.knxConnection = null;
    }
  }

  onKnxConnected() {
    this.knxConnected = true;
    this.setState('info.connection', true, true);
    this.log.info('KNX connected ✅');

    this.startTxQueue();

    // (Re)create datapoints
    this.createDatapoints();

    // Read initial values
    if (this.config.readOnStart) {
      this.enqueueInitialReads();
    }
  }

  onKnxDisconnected() {
    this.knxConnected = false;
    this.setState('info.connection', false, true);
    this.log.warn('KNX disconnected ❌');
  }

  onKnxError(err) {
    this.log.warn(`KNX error: ${err?.message || JSON.stringify(err)}`);
  }

  startTxQueue() {
    if (this.txTimer) return;

    const interval = Math.max(10, Number(this.config.minimumDelayMs || 25));

    this.txTimer = setInterval(() => {
      if (!this.knxConnected) return;
      const job = this.txQueue.shift();
      if (!job) return;
      try {
        job.fn();
      } catch (e) {
        this.log.warn(`KNX TX failed (${job.descr}): ${e?.message || e}`);
      }
    }, interval);
  }

  enqueueKnx(fn, descr) {
    this.txQueue.push({ fn, descr: descr || 'tx' });
  }

  createDatapoints() {
    if (!this.knxConnection) return;

    // Cleanup old datapoints
    for (const dp of this.datapointsByStateId.values()) {
      try {
        dp.removeAllListeners();
      } catch {
        // ignore
      }
    }
    this.datapointsByStateId.clear();

    for (const [stateIdRel, meta] of this.metaByStateId.entries()) {
      try {
        const dp = new knx.Datapoint({
          ga: meta.ga,
          dpt: meta.dpt,
          autoread: false
        }, this.knxConnection);

        dp.on('change', (oldVal, newVal) => {
          this.onKnxDatapointChange(stateIdRel, oldVal, newVal);
        });

        this.datapointsByStateId.set(stateIdRel, dp);
      } catch (e) {
        this.log.warn(`Failed to create datapoint for ${stateIdRel} (${meta.ga}): ${e?.message || e}`);
      }
    }

    this.log.info(`KNX datapoints bound: ${this.datapointsByStateId.size}`);
  }

  enqueueInitialReads() {
    for (const [stateIdRel, meta] of this.metaByStateId.entries()) {
      const dp = this.datapointsByStateId.get(stateIdRel);
      if (!dp) continue;

      // Only read if ETS says it's readable (or if unknown)
      if (meta.flags?.readFlag) {
        this.enqueueKnx(() => dp.read(), `read ${meta.ga}`);
      }
    }

    this.log.info('Initial GroupValueRead queued.');
  }

  async onKnxDatapointChange(stateIdRel, oldVal, newVal) {
    // Map Date to ISO string for ioBroker storage
    let val = newVal;
    if (val instanceof Date) {
      val = val.toISOString();
    }

    try {
      await this.setStateAsync(stateIdRel, val, true);
    } catch (e) {
      this.log.warn(`Failed to setState ${stateIdRel}: ${e?.message || e}`);
    }
  }

  // -------------------------
  // ioBroker -> KNX writes
  // -------------------------

  async onStateChange(idFull, state) {
    if (!state) return;
    if (state.ack) return;

    const prefix = `${this.namespace}.`;
    if (!idFull.startsWith(prefix)) return;

    const idRel = idFull.slice(prefix.length);

    if (!idRel.startsWith('ga.')) return;

    const meta = this.metaByStateId.get(idRel);
    const dp = this.datapointsByStateId.get(idRel);

    if (!meta || !dp) {
      this.log.debug(`State change ignored (no mapping): ${idRel}`);
      return;
    }

    const flags = meta.flags || {};

    // Write
    if (flags.writeFlag) {
      const value = coerceToKnxValue(state.val, meta.dpt);
      this.enqueueKnx(() => dp.write(value), `write ${meta.ga}`);

      if (this.config.ackOnWrite) {
        // mark as processed
        await this.setStateAsync(idRel, state.val, true);
      }
      return;
    }

    // Read trigger
    if (flags.readFlag) {
      this.enqueueKnx(() => dp.read(), `read ${meta.ga}`);

      if (this.config.ackOnWrite) {
        await this.setStateAsync(idRel, state.val, true);
      }
      return;
    }

    this.log.debug(`State not writeable/readable by flags: ${idRel} (${meta.ga})`);

    if (this.config.ackOnWrite) {
      await this.setStateAsync(idRel, state.val, true);
    }
  }
}

// If started as allInOne/compact mode => export class, else start instance
if (module.parent) {
  module.exports = (options) => new NexowattKnx(options);
} else {
  new NexowattKnx();
}
