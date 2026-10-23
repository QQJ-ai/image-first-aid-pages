// Small, dependency-free ZIP writer. Files are stored without recompression.
const UINT32_LIMIT = 0xffffffff;
const UINT16_LIMIT = 0xffff;
const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function crc32(bytes) {
  let crc = 0xffffffff;
  for (let index = 0; index < bytes.length; index += 1) {
    crc = crcTable[(crc ^ bytes[index]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip32(value, description) {
  // The all-ones value is reserved for a ZIP64 extension.
  if (!Number.isSafeInteger(value) || value < 0 || value >= UINT32_LIMIT) {
    throw new RangeError(`${description}超出 ZIP32 限制，请分批下载。`);
  }
  return value;
}

function uniqueName(inputName, index, used) {
  // Uploaded filenames have no folders. Keep archives safe to extract as well.
  const baseName = String(inputName ?? '')
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .trim();
  const original = baseName && baseName !== '.' && baseName !== '..'
    ? baseName
    : `image-${index + 1}`;
  let candidate = original;
  let suffix = 2;
  const dot = original.lastIndexOf('.');
  const stem = dot > 0 ? original.slice(0, dot) : original;
  const extension = dot > 0 ? original.slice(dot) : '';
  while (used.has(candidate.toLocaleLowerCase())) {
    candidate = `${stem} (${suffix})${extension}`;
    suffix += 1;
  }
  used.add(candidate.toLocaleLowerCase());
  return candidate;
}

function dosTimestamp(date) {
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | (date.getSeconds() >> 1),
    date: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

/**
 * Build a UTF-8 ZIP archive from [{ name, blob }]. Duplicate names get (2), (3), ….
 * @param {{name: string, blob: Blob}[]} files
 * @returns {Promise<Blob>}
 */
export async function createZip(files) {
  if (!Array.isArray(files)) throw new TypeError('ZIP 文件列表必须是数组。');
  if (files.length >= UINT16_LIMIT) {
    throw new RangeError('文件数量超出 ZIP32 限制，请分批下载。');
  }

  const used = new Set();
  const entries = [];
  let dataSize = 0;
  let directorySize = 0;
  // Preflight the complete archive before reading any image into memory.
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file || !(file.blob instanceof Blob)) {
      throw new TypeError(`第 ${index + 1} 个文件缺少有效的 Blob。`);
    }
    const size = zip32(file.blob.size, '单个文件大小');
    const name = encoder.encode(uniqueName(file.name, index, used));
    if (name.length > UINT16_LIMIT) throw new RangeError('文件名过长，请缩短后重试。');
    const offset = zip32(dataSize, 'ZIP 文件偏移');
    dataSize = zip32(dataSize + 30 + name.length + size, 'ZIP 文件大小');
    directorySize = zip32(directorySize + 46 + name.length, 'ZIP 目录大小');
    entries.push({ blob: file.blob, name, size, offset });
  }
  zip32(dataSize + directorySize + 22, 'ZIP 文件总大小');

  const timestamp = dosTimestamp(new Date());
  const contents = [];
  const directory = [];

  for (const entry of entries) {
    const checksum = crc32(new Uint8Array(await entry.blob.arrayBuffer()));
    const local = new Uint8Array(30 + entry.name.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true); // UTF-8 filenames.
    localView.setUint16(8, 0, true); // Stored, no compression.
    localView.setUint16(10, timestamp.time, true);
    localView.setUint16(12, timestamp.date, true);
    localView.setUint32(14, checksum, true);
    localView.setUint32(18, entry.size, true);
    localView.setUint32(22, entry.size, true);
    localView.setUint16(26, entry.name.length, true);
    local.set(entry.name, 30);
    contents.push(local, entry.blob);

    const central = new Uint8Array(46 + entry.name.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint16(12, timestamp.time, true);
    centralView.setUint16(14, timestamp.date, true);
    centralView.setUint32(16, checksum, true);
    centralView.setUint32(20, entry.size, true);
    centralView.setUint32(24, entry.size, true);
    centralView.setUint16(28, entry.name.length, true);
    centralView.setUint32(42, entry.offset, true);
    central.set(entry.name, 46);
    directory.push(central);
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, directorySize, true);
  endView.setUint32(16, dataSize, true);
  return new Blob([...contents, ...directory, end], { type: 'application/zip' });
}
