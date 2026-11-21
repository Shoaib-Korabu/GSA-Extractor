// lib/zip-writer.js
// Pure JavaScript PKZIP writer with zero external dependencies.
// Creates standard uncompressed (STORE) ZIP archives compatible with all OS extractors.

/**
 * Computes standard CRC-32 checksum for a Uint8Array or Buffer.
 */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) {
        c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      }
      table[i] = c >>> 0;
    }
    crc32.table = table;
  }

  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

/**
/**
 * Converts a JS Date into MS-DOS 16-bit time and date values.
 */
function toDosDateTime(dateInput) {
  const d = dateInput instanceof Date ? dateInput : (dateInput ? new Date(dateInput) : new Date());
  const year = Math.max(1980, d.getFullYear());
  const month = d.getMonth() + 1;
  const day = d.getDate();
  const hours = d.getHours();
  const minutes = d.getMinutes();
  const seconds = d.getSeconds();

  const dosTime = ((hours & 0x1F) << 11) | ((minutes & 0x3F) << 5) | ((seconds >> 1) & 0x1F);
  const dosDate = (((year - 1980) & 0x7F) << 9) | ((month & 0x0F) << 5) | (day & 0x1F);
  return { dosTime, dosDate };
}

/**
 * Creates a ZIP archive containing the provided files.
 *
 * @param {Array<{name: string, data: string|Uint8Array|Buffer, date?: Date|string}>} files
 * @returns {Uint8Array} Binary ZIP archive
 */
function createZipArchive(files) {
  const textEncoder = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
  const toUint8 = (val) => {
    if (val instanceof Uint8Array) return val;
    if (typeof Buffer !== 'undefined' && Buffer.isBuffer(val)) return new Uint8Array(val);
    if (typeof val === 'string') {
      return textEncoder ? textEncoder.encode(val) : Buffer.from(val, 'utf8');
    }
    return new Uint8Array(0);
  };

  const seenNames = new Map();
  const sanitizeName = (rawName) => {
    let name = String(rawName || 'file.json').replace(/\\/g, '/');
    if (seenNames.has(name)) {
      const count = seenNames.get(name) + 1;
      seenNames.set(name, count);
      const dotIdx = name.lastIndexOf('.');
      if (dotIdx > 0) {
        name = `${name.slice(0, dotIdx)}_${count}${name.slice(dotIdx)}`;
      } else {
        name = `${name}_${count}`;
      }
    } else {
      seenNames.set(name, 1);
    }
    return name;
  };

  const localEntries = [];
  const centralEntries = [];
  let currentOffset = 0;

  for (const file of files) {
    const finalName = sanitizeName(file.name);
    const filenameBytes = toUint8(finalName);
    const dataBytes = toUint8(file.data);
    const checksum = crc32(dataBytes);
    const size = dataBytes.length;
    const { dosTime, dosDate } = toDosDateTime(file.date || new Date());

    // 1. Local File Header (30 bytes + name + data)
    const localHeader = new Uint8Array(30);
    const localView = new DataView(localHeader.buffer, localHeader.byteOffset, localHeader.byteLength);

    localView.setUint32(0, 0x04034b50, true); // Local file header signature
    localView.setUint16(4, 20, true);         // Version needed: 2.0
    localView.setUint16(6, 0x0800, true);     // Flags: Bit 11 set for UTF-8 filename encoding
    localView.setUint16(8, 0, true);          // Compression: 0 (Store)
    localView.setUint16(10, dosTime, true);   // Mod time (MS-DOS)
    localView.setUint16(12, dosDate, true);   // Mod date (MS-DOS)
    localView.setUint32(14, checksum, true);  // CRC-32
    localView.setUint32(18, size, true);      // Compressed size
    localView.setUint32(22, size, true);      // Uncompressed size
    localView.setUint16(26, filenameBytes.length, true); // Filename length
    localView.setUint16(28, 0, true);         // Extra field length

    localEntries.push(localHeader, filenameBytes, dataBytes);

    // 2. Central Directory File Header (46 bytes + name)
    const centralHeader = new Uint8Array(46);
    const centralView = new DataView(centralHeader.buffer, centralHeader.byteOffset, centralHeader.byteLength);

    centralView.setUint32(0, 0x02014b50, true); // Central directory header signature
    centralView.setUint16(4, 20, true);         // Version made by: 2.0
    centralView.setUint16(6, 20, true);         // Version needed: 2.0
    centralView.setUint16(8, 0x0800, true);     // Flags: UTF-8 encoding
    centralView.setUint16(10, 0, true);         // Compression: 0
    centralView.setUint16(12, dosTime, true);   // Mod time (MS-DOS)
    centralView.setUint16(14, dosDate, true);   // Mod date (MS-DOS)
    centralView.setUint32(16, checksum, true);  // CRC-32
    centralView.setUint32(20, size, true);      // Compressed size
    centralView.setUint32(24, size, true);      // Uncompressed size
    centralView.setUint16(28, filenameBytes.length, true); // Filename length
    centralView.setUint16(30, 0, true);         // Extra field length
    centralView.setUint16(32, 0, true);         // Comment length
    centralView.setUint16(34, 0, true);         // Disk start
    centralView.setUint16(36, 0, true);         // Internal attributes
    centralView.setUint32(38, 0, true);         // External attributes
    centralView.setUint32(42, currentOffset, true); // Relative offset of local header

    centralEntries.push(centralHeader, filenameBytes);

    currentOffset += localHeader.length + filenameBytes.length + dataBytes.length;
  }

  const centralOffset = currentOffset;

  // Calculate total central directory size
  let centralSize = 0;
  for (const part of centralEntries) {
    centralSize += part.length;
  }

  // 3. End of Central Directory Record (22 bytes)
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer, eocd.byteOffset, eocd.byteLength);

  eocdView.setUint32(0, 0x06054b50, true); // EOCD signature
  eocdView.setUint16(4, 0, true);          // Disk number
  eocdView.setUint16(6, 0, true);          // Start disk
  eocdView.setUint16(8, files.length, true); // Entries on this disk
  eocdView.setUint16(10, files.length, true); // Total entries
  eocdView.setUint32(12, centralSize, true); // Central directory size
  eocdView.setUint32(16, centralOffset, true); // Central directory offset
  eocdView.setUint16(20, 0, true);         // Comment length

  // Concatenate all buffers into single Uint8Array
  let totalLength = 0;
  for (const p of localEntries) totalLength += p.length;
  totalLength += centralSize + eocd.length;

  const result = new Uint8Array(totalLength);
  let pos = 0;

  for (const p of localEntries) {
    result.set(p, pos);
    pos += p.length;
  }
  for (const p of centralEntries) {
    result.set(p, pos);
    pos += p.length;
  }
  result.set(eocd, pos);

  return result;
}

/**
 * Creates a downloadable Blob for browser environments.
 */
function createZipBlob(files) {
  const uint8 = createZipArchive(files);
  return new Blob([uint8], { type: 'application/zip' });
}

// Export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    crc32,
    toDosDateTime,
    createZipArchive,
    createZipBlob
  };
} else if (typeof globalThis !== 'undefined') {
  globalThis.GSAZip = {
    crc32,
    toDosDateTime,
    createZipArchive,
    createZipBlob
  };
}
