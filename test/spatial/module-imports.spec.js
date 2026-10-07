// Every relative import under public/js must name a file that exists with exactly that spelling. Windows file systems
// ignore case and treat status-pill.js and status_pill.js alike only by accident of the typo; Cloudflare's asset store does
// not, and a miss there comes back from the Worker as a 404, which a browser shows as a failed module load.
// The two *.bundle.js files are built by `npm run build:client` (wrangler and `npm test` run it first), so they must exist too.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, normalize, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(process.cwd(), 'public', 'js');

function jsFiles(dir) {
	return readdirSync(dir).flatMap((name) => {
		const full = join(dir, name);
		return statSync(full).isDirectory() ? jsFiles(full) : name.endsWith('.js') ? [full] : [];
	});
}

// True only when every path segment matches an existing directory entry exactly (case included).
function existsExactly(file) {
	const parts = relative(process.cwd(), normalize(file)).split(sep);
	let dir = process.cwd();
	for (const part of parts) {
		if (!readdirSync(dir).includes(part)) return false;
		dir = join(dir, part);
	}
	return true;
}

describe('public/js module imports', () => {
	it('resolve to real files with the exact spelling used', () => {
		const problems = [];
		for (const file of jsFiles(root)) {
			const source = readFileSync(file, 'utf8');
			const specs = [...source.matchAll(/(?:from\s*|import\s*\(?\s*)['"](\.{1,2}\/[^'"]+)['"]/g)].map((m) => m[1]);
			for (const spec of specs) {
				const target = join(dirname(file), spec.split('?')[0]);
				if (!existsExactly(target)) problems.push(relative(process.cwd(), file) + ' imports ' + spec);
			}
		}
		expect(problems).toEqual([]);
	});

	it('includes the status pill and shell shortcuts in what it checks', () => {
		const names = jsFiles(root).map((f) => relative(root, f).split(sep).join('/'));
		expect(names).toContain('engine/status-pill.js');
		expect(names).toContain('shell-keys.js');
	});
});
