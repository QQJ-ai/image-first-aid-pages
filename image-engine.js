/** All image decoding and processing happens in the current browser. */
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_DIMENSION = 12000;
const MAX_PIXELS = 40 * 1000 * 1000;
const OUTPUT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const MODES = new Set(['compress', 'resize', 'convert', 'redact']);
const EXTENSIONS = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/bmp': 'bmp', 'image/gif': 'gif' };

function checkDimensions(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new Error('图片宽高必须是大于 0 的整数。');
  }
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    throw new Error('图片的单边尺寸不能超过 12000 像素，请先缩小图片。');
  }
  if (width * height > MAX_PIXELS) {
    throw new Error('图片总像素不能超过 4000 万，请先缩小图片。');
  }
}

async function detectImageType(file) {
  const bytes = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  const ascii = (start, end) => String.fromCharCode(...bytes.slice(start, end));
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  if (ascii(0, 6) === 'GIF87a' || ascii(0, 6) === 'GIF89a') return 'image/gif';
  if (ascii(0, 2) === 'BM') return 'image/bmp';
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  if (ascii(4, 8) === 'ftyp') {
    throw new Error('暂不支持 HEIC、HEIF 或 AVIF 图片，请先转换为 JPG、PNG 或 WebP。');
  }
  throw new Error('无法识别图片格式，请使用有效的 JPG、PNG、WebP、BMP 或 GIF 文件。');
}

/**
 * Load a local File. The caller owns the returned object URL and must eventually
 * call URL.revokeObjectURL(item.url) when replacing or removing the item.
 * GIF inputs are processed as a still image; animation is not retained.
 */
export async function loadImage(file) {
  if (!(file instanceof Blob)) throw new Error('请选择一个图片文件。');
  if (file.size === 0) throw new Error('这个文件是空的，请重新选择图片。');
  if (file.size > MAX_FILE_BYTES) throw new Error('单张图片不能超过 20 MB，请选择更小的文件。');
  const name = String(file.name || '未命名图片');
  if (/\.svgz?$/i.test(name) || /image\/svg\+xml/i.test(file.type)) {
    throw new Error('暂不支持 SVG 图片，请先转换为 PNG 或 JPG。');
  }
  if (/\.(?:heic|heif|avif)$/i.test(name) || /image\/(?:heic|heif|avif)/i.test(file.type)) {
    throw new Error('暂不支持 HEIC、HEIF 或 AVIF 图片，请先转换为 JPG、PNG 或 WebP。');
  }
  await detectImageType(file);
  const url = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('图片无法读取，文件可能已损坏，或当前浏览器不支持此图片。'));
      image.src = url;
    });
    checkDimensions(image.naturalWidth, image.naturalHeight);
    return {
      id: globalThis.crypto?.randomUUID?.() || `image-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      name,
      file,
      width: image.naturalWidth,
      height: image.naturalHeight,
      image,
      url,
    };
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

function outputName(name, type) {
  const base = String(name || '图片').replace(/\.[^.]+$/, '') || '图片';
  return `${base}-急救站.${EXTENSIONS[type]}`;
}

function resizedDimensions(item, options) {
  const parseDimension = (value) => {
    const number = Number(value);
    if (!Number.isInteger(number) || number < 1 || number > MAX_DIMENSION) {
      throw new Error('目标宽高须为 1 至 12000 之间的整数。');
    }
    return number;
  };
  const hasWidth = options.width !== undefined && options.width !== null && options.width !== '';
  const hasHeight = options.height !== undefined && options.height !== null && options.height !== '';
  if (!hasWidth && !hasHeight) return { width: item.width, height: item.height };
  const width = hasWidth ? parseDimension(options.width) : Math.max(1, Math.round(item.width * parseDimension(options.height) / item.height));
  const height = hasHeight ? parseDimension(options.height) : Math.max(1, Math.round(item.height * width / item.width));
  checkDimensions(width, height);
  return { width, height };
}

function paintRedactions(context, rectangles, width, height) {
  if (!Array.isArray(rectangles)) throw new Error('遮挡区域格式有误，请重新选择区域。');
  context.fillStyle = '#172520';
  context.globalAlpha = 1;
  context.globalCompositeOperation = 'source-over';
  for (const rect of rectangles) {
    if (!rect || !['x', 'y', 'w', 'h'].every((key) => Number.isFinite(rect[key]))) {
      throw new Error('遮挡区域格式有误，请重新选择区域。');
    }
    if (rect.x < 0 || rect.y < 0 || rect.w < 0 || rect.h < 0 || rect.x > 1 || rect.y > 1 || rect.w > 1 || rect.h > 1) {
      throw new Error('遮挡区域须位于图片范围内，请重新选择区域。');
    }
    const left = Math.floor(rect.x * width);
    const top = Math.floor(rect.y * height);
    const right = Math.ceil(Math.min(1, rect.x + rect.w) * width);
    const bottom = Math.ceil(Math.min(1, rect.y + rect.h) * height);
    if (rect.w > 0 && rect.h > 0) context.fillRect(left, top, right - left, bottom - top);
  }
}

/**
 * Produce a new flattened bitmap with browser Canvas. Resizing uses the supplied
 * width/height, preserving the aspect ratio when only one dimension is supplied.
 * Redaction rectangles use normalized source-image coordinates in [0, 1].
 * Newly encoded output has no source metadata, layers, or GIF animation.
 * Same-format compression may return the original file when encoding is larger.
 */
export async function processImage(item, options = {}) {
  if (!item?.image || !(item.file instanceof Blob)) throw new Error('请先选择并加载图片。');
  const mode = options.mode || 'compress';
  const type = options.format || 'image/jpeg';
  const quality = options.quality ?? 0.8;
  if (!MODES.has(mode)) throw new Error('请选择有效的图片处理方式。');
  if (!OUTPUT_TYPES.has(type)) throw new Error('导出格式仅支持 JPG、PNG 和 WebP。');
  if (!Number.isFinite(quality) || quality < 0 || quality > 1) throw new Error('图片质量必须在 0 至 1 之间。');
  checkDimensions(item.width, item.height);
  const { width, height } = mode === 'resize' ? resizedDimensions(item, options) : item;
  checkDimensions(width, height);
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  try {
    const context = canvas.getContext('2d');
    if (!context) throw new Error('当前浏览器无法处理图片，请使用新版 Chrome、Edge、Safari 或 Firefox。');
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    // JPEG has no alpha channel; flatten transparent pixels against white.
    if (type === 'image/jpeg') {
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, width, height);
    }
    context.drawImage(item.image, 0, 0, width, height);
    if (mode === 'redact') paintRedactions(context, options.redactions || [], width, height);
    const blob = await new Promise((resolve, reject) => {
      try {
        canvas.toBlob((value) => value ? resolve(value) : reject(new Error('图片导出失败，可能是内存不足，请尝试更小的图片。')), type, quality);
      } catch {
        reject(new Error('图片导出失败，请尝试更小的图片或其他格式。'));
      }
    });
    if (blob.type.toLowerCase() !== type) {
      throw new Error(`当前浏览器不支持导出 ${EXTENSIONS[type].toUpperCase()} 格式，请选择其他格式。`);
    }
    let resultBlob = blob;
    if (mode === 'compress' && blob.size >= item.file.size && type === await detectImageType(item.file)) {
      // Compression should never make a same-format file larger.
      resultBlob = item.file.type === type ? item.file : new Blob([item.file], { type });
    }
    return { blob: resultBlob, width, height, name: outputName(item.name, type), type, originalSize: item.file.size };
  } finally {
    // Promptly release the large backing store after encoding completes.
    canvas.width = 0;
    canvas.height = 0;
  }
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const index = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1));
  const value = bytes / (1024 ** index);
  return `${index === 0 ? Math.round(value) : value.toFixed(value >= 10 ? 1 : 2)} ${units[index]}`;
}

export function downloadBlob(blob, name = '图片-急救站.png') {
  if (!(blob instanceof Blob)) throw new Error('下载文件无效，请重新处理图片。');
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.style.display = 'none';
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Leave enough time for browsers to begin receiving the download.
    setTimeout(() => URL.revokeObjectURL(url), 30000);
  }
}
