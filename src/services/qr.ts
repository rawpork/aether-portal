// QR codes for Mission Control's engine pairing (bundled to public/js/qr.bundle.js by `npm run build:client`).
// Wraps qrcode-generator (MIT) and draws its own SVG: one path of dark modules on a white quiet zone, which is what
// phone cameras need to read it reliably on the dark portal theme.
import qrcode from 'qrcode-generator';

export interface QrOptions {
	// Quiet zone in modules (the spec asks for 4).
	margin?: number;
	// Error correction: L, M (default), Q or H.
	level?: 'L' | 'M' | 'Q' | 'H';
	// Accessible name for the image.
	label?: string;
}

export interface QrMatrix {
	size: number;
	isDark(row: number, col: number): boolean;
}

export function makeQrMatrix(text: string, level: QrOptions['level'] = 'M'): QrMatrix {
	const qr = qrcode(0, level ?? 'M');
	qr.addData(text, 'Byte');
	qr.make();
	return { size: qr.getModuleCount(), isDark: (row, col) => qr.isDark(row, col) };
}

const escapeXml = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function renderQrSvg(text: string, options: QrOptions = {}): string {
	const margin = options.margin ?? 4;
	const matrix = makeQrMatrix(text, options.level);
	const full = matrix.size + margin * 2;
	let path = '';
	for (let row = 0; row < matrix.size; row++) {
		for (let col = 0; col < matrix.size; col++) {
			if (matrix.isDark(row, col)) path += 'M' + (col + margin) + ' ' + (row + margin) + 'h1v1h-1z';
		}
	}
	const label = escapeXml(options.label ?? 'QR code');
	return (
		'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + full + ' ' + full + '" shape-rendering="crispEdges" role="img" aria-label="' + label + '">' +
		'<rect width="' + full + '" height="' + full + '" fill="#ffffff"/>' +
		'<path d="' + path + '" fill="#041016"/>' +
		'</svg>'
	);
}
