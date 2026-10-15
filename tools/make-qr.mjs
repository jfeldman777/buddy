import { writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import QRCode from 'qrcode';

export const SITE_URL = 'https://jfeldman777.github.io/buddy/';
export const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2, color: { dark: '#000000', light: '#ffffff' } };

export function makeQrSvg() {
  return QRCode.toString(SITE_URL, { ...QR_OPTIONS, type: 'svg' });
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const svg = await makeQrSvg();
  await writeFile(new URL('../web/qr.svg', import.meta.url), svg);
  console.log(`web/qr.svg -> ${SITE_URL}`);
}
