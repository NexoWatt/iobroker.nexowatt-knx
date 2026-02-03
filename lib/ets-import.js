'use strict';

const path = require('path');
const fs = require('fs/promises');
const crypto = require('crypto');

const {
  groupAddressNumberToString,
  etsDptToKnxDpt,
  sanitizeIdSegment
} = require('./knx-utils');

let etsProjParser;
try {
  // CommonJS / ESM interop
  const pkg = require('ets_proj_parser');
  etsProjParser = pkg.default || pkg;
} catch (e) {
  etsProjParser = null;
}

/**
 * Build a map GA_ID -> aggregated flags based on device communication object references.
 * @param {any} result
 * @returns {Map<string, {readFlag:boolean, writeFlag:boolean, transmitFlag:boolean, updateFlag:boolean}>}
 */
function buildFlagsByGroupAddressId(result) {
  const map = new Map();

  const areas = result?.topology?.areas || [];
  for (const area of areas) {
    for (const line of area?.lines || []) {
      for (const device of line?.devices || []) {
        const cors = device?.communicationObjectReferences || [];
        for (const cor of cors) {
          if (cor && cor.isActive === false) continue;

          const flags = {
            readFlag: Boolean(cor?.readFlag),
            writeFlag: Boolean(cor?.writeFlag),
            transmitFlag: Boolean(cor?.transmitFlag),
            updateFlag: Boolean(cor?.updateFlag)
          };

          const connectors = cor?.connectors || [];
          for (const conn of connectors) {
            // send
            for (const s of conn?.send || []) {
              const gaId = s?.__groupAddressRefID;
              if (!gaId) continue;
              const agg = map.get(gaId) || { readFlag: false, writeFlag: false, transmitFlag: false, updateFlag: false };
              agg.readFlag ||= flags.readFlag;
              agg.writeFlag ||= flags.writeFlag;
              agg.transmitFlag ||= flags.transmitFlag;
              agg.updateFlag ||= flags.updateFlag;
              map.set(gaId, agg);
            }
            // receive
            for (const r of conn?.receive || []) {
              const gaId = r?.__groupAddressRefID || r?.__groupAddressRedID;
              if (!gaId) continue;
              const agg = map.get(gaId) || { readFlag: false, writeFlag: false, transmitFlag: false, updateFlag: false };
              agg.readFlag ||= flags.readFlag;
              agg.writeFlag ||= flags.writeFlag;
              agg.transmitFlag ||= flags.transmitFlag;
              agg.updateFlag ||= flags.updateFlag;
              map.set(gaId, agg);
            }
          }
        }
      }
    }
  }

  return map;
}

/**
 * Recursively traverse group ranges and collect group addresses.
 * @param {any[]} groupRanges
 * @param {string[]} pathSegments
 * @param {any[]} out
 */
function walkGroupRanges(groupRanges, pathSegments, out) {
  if (!Array.isArray(groupRanges)) return;

  for (const gr of groupRanges) {
    const nextPath = [...pathSegments];
    if (gr?.name) nextPath.push(String(gr.name));

    // nested ranges
    if (Array.isArray(gr?.groupRanges) && gr.groupRanges.length) {
      walkGroupRanges(gr.groupRanges, nextPath, out);
    }

    // group addresses
    if (Array.isArray(gr?.groupAddresses)) {
      for (const ga of gr.groupAddresses) {
        out.push({ groupRangePath: nextPath, groupAddress: ga });
      }
    }
  }
}

/**
 * Import ETS .knxproj file from ioBroker file storage.
 *
 * @param {import('@iobroker/adapter-core').AdapterInstance} adapter
 * @param {string} etsFileName file name inside ioBroker Files -> nexowatt-knx.0 (files)
 * @param {{ gaStyleOverride?: 'auto'|'ThreeLevel'|'TwoLevel' }} [options]
 * @returns {Promise<{hash:string, style:'ThreeLevel'|'TwoLevel'|'Free', entries: Array<{id:string, name:string, ga:string, dpt?:string, flags:{readFlag:boolean, writeFlag:boolean, transmitFlag:boolean, updateFlag:boolean}, description?:string}>}>}
 */
async function importEtsProject(adapter, etsFileName, options = {}) {
  if (!etsProjParser) {
    throw new Error('Dependency "ets_proj_parser" not available');
  }

  if (!etsFileName || typeof etsFileName !== 'string') {
    throw new Error('No ETS project file configured');
  }

  // Read from ioBroker file storage (default: nexowatt-knx.0.files)
  let fileName = etsFileName.trim();
  let fileObj;
  try {
    fileObj = await adapter.readFileAsync(`${adapter.namespace}.files`, fileName);
  } catch {
    fileObj = null;
  }
  let file = fileObj?.file;

  // Backward compatibility: if only the basename is stored, also try ets/<name>
  if (!file && fileName && !fileName.includes('/')) {
    const alt = `ets/${fileName}`;
    try {
      const altObj = await adapter.readFileAsync(`${adapter.namespace}.files`, alt);
      if (altObj?.file) {
        fileName = alt;
        file = altObj.file;
      }
    } catch {
      // ignore
    }
  }

  if (!file) {
    throw new Error(`Could not read ETS project from ioBroker Files: ${adapter.namespace}.files/${fileName}`);
  }

  const hash = crypto.createHash('sha256').update(file).digest('hex');

  // Persist to local FS (ets_proj_parser wants a path)
  const dataDir = adapter.getDataDir();
  await fs.mkdir(dataDir, { recursive: true });

  const projectPath = path.join(dataDir, 'project.knxproj');
  const workDir = path.join(dataDir, 'ets_unpack');

  await fs.writeFile(projectPath, file);
  await fs.rm(workDir, { recursive: true, force: true });
  await fs.mkdir(workDir, { recursive: true });

  const init = await etsProjParser(projectPath, workDir);
  if (init && init.constructor === Error) {
    throw init;
  }

  // We don't need device app details for GA import
  const result = await init(false);
  if (result && result.constructor === Error) {
    throw result;
  }

  const styleFromProject = result?.projectInformation?.groupAddressStyle || 'ThreeLevel';
  const style = (options.gaStyleOverride && options.gaStyleOverride !== 'auto') ? options.gaStyleOverride : styleFromProject;

  const flagsByGaId = buildFlagsByGroupAddressId(result);

  const collected = [];

  // result.groupAddresses is an array. Each element contains groupRanges.
  const gaRoots = Array.isArray(result?.groupAddresses) ? result.groupAddresses : [];
  for (const root of gaRoots) {
    walkGroupRanges(root?.groupRanges || [], [], collected);
  }

  const entries = collected.map(({ groupRangePath, groupAddress }) => {
    const gaNum = groupAddress?.address;
    const gaStr = groupAddressNumberToString(gaNum, style);
    const dpt = etsDptToKnxDpt(groupAddress?.datapointType);

    const gaId = groupAddress?.ID;
    const flags = flagsByGaId.get(gaId) || { readFlag: false, writeFlag: false, transmitFlag: true, updateFlag: false };

    // Build an ioBroker id: ga.<sanitized path>.<ga>
    const segs = ['ga', ...groupRangePath.map(sanitizeIdSegment)];
    const gaSeg = sanitizeIdSegment(gaStr.replace(/\//g, '_'));
    const id = [...segs, gaSeg].filter(Boolean).join('.');

    return {
      id,
      name: String(groupAddress?.name || gaStr),
      description: groupAddress?.description ? String(groupAddress.description) : undefined,
      ga: gaStr,
      dpt,
      flags
    };
  });

  return { hash, style, entries };
}

module.exports = {
  importEtsProject
};
