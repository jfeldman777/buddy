// Client-side resize for photos shown to Bi (gallery file or capture= camera input).
const PHOTO_MAX_EDGE = 512;
const PHOTO_JPEG_QUALITY = 0.72;

export async function fileToPhotoDataUrl(file) {
  if (!file || !/^image\//i.test(file.type)) {
    throw new Error('Нужно изображение (JPEG, PNG или WebP).');
  }
  const bitmap = await createImageBitmap(file);
  try {
    return bitmapToJpegDataUrl(bitmap);
  } finally {
    bitmap.close?.();
  }
}

function bitmapToJpegDataUrl(bitmap) {
  const scale = Math.min(1, PHOTO_MAX_EDGE / Math.max(bitmap.width, bitmap.height));
  const w = Math.max(1, Math.round(bitmap.width * scale));
  const h = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, w, h);
  const dataUrl = canvas.toDataURL('image/jpeg', PHOTO_JPEG_QUALITY);
  if (dataUrl.length > 340_000) throw new Error('Фото слишком большое даже после сжатия.');
  return dataUrl;
}
