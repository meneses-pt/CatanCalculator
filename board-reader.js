// Reads a colonist.io board screenshot and returns the 19 number tokens.
//
// Pipeline: find the cream number tokens -> fit them to the 3-4-5-4-3 hex lattice
// -> read each token's digits by template matching. Works on any zoom level
// because everything is derived from the size of the tokens themselves.
//
// Input is any {width, height, data} with RGBA bytes (a canvas ImageData works).
// Output index order matches the inputs in index.html: rows top to bottom, left to right.

(function (root) {
	const TOKEN_RGB = [232, 231, 227]
	const TOKEN_TOLERANCE = 10 // per channel

	const ROW_LENGTHS = [3, 4, 5, 4, 3]
	const ROW_OFFSETS = [2, 1, 0, 1, 2] // in half-hex units from the widest row
	const ROW_SPACING = Math.sqrt(3) / 2 // vertical pitch / hex width (pointy-top hexes)

	// Token width / hex width as drawn by colonist.io.
	const TOKEN_TO_HEX = 0.385

	const GLYPH_W = 16
	const GLYPH_H = 24

	// Expected numbers in a standard game; used only to flag likely misreads.
	const STANDARD_COUNTS = { 2: 1, 3: 2, 4: 2, 5: 2, 6: 2, 8: 2, 9: 2, 10: 2, 11: 2, 12: 1 }

	// Lattice position (row, half-column) for each of the 19 inputs.
	const POSITIONS = []
	for (let r = 0; r < 5; r++) {
		for (let k = 0; k < ROW_LENGTHS[r]; k++) {
			POSITIONS.push({ row: r, col: ROW_OFFSETS[r] + 2 * k })
		}
	}

	// GLYPH_TEMPLATES is filled in by the generated block at the bottom of this file.
	let GLYPH_TEMPLATES = {}

	// ---- token detection ---------------------------------------------------

	function findTokens(img) {
		const { width, height, data } = img
		const mask = new Uint8Array(width * height)
		for (let i = 0, p = 0; i < mask.length; i++, p += 4) {
			if (Math.abs(data[p] - TOKEN_RGB[0]) <= TOKEN_TOLERANCE &&
				Math.abs(data[p + 1] - TOKEN_RGB[1]) <= TOKEN_TOLERANCE &&
				Math.abs(data[p + 2] - TOKEN_RGB[2]) <= TOKEN_TOLERANCE) mask[i] = 1
		}

		const seen = new Uint8Array(width * height)
		const stack = new Int32Array(width * height)
		const found = []

		for (let start = 0; start < mask.length; start++) {
			if (!mask[start] || seen[start]) continue
			let sp = 0
			stack[sp++] = start
			seen[start] = 1
			let minX = width, maxX = 0, minY = height, maxY = 0, area = 0
			while (sp > 0) {
				const idx = stack[--sp]
				const x = idx % width
				const y = (idx - x) / width
				area++
				if (x < minX) minX = x
				if (x > maxX) maxX = x
				if (y < minY) minY = y
				if (y > maxY) maxY = y
				if (x > 0 && mask[idx - 1] && !seen[idx - 1]) { seen[idx - 1] = 1; stack[sp++] = idx - 1 }
				if (x < width - 1 && mask[idx + 1] && !seen[idx + 1]) { seen[idx + 1] = 1; stack[sp++] = idx + 1 }
				if (y > 0 && mask[idx - width] && !seen[idx - width]) { seen[idx - width] = 1; stack[sp++] = idx - width }
				if (y < height - 1 && mask[idx + width] && !seen[idx + width]) { seen[idx + width] = 1; stack[sp++] = idx + width }
			}
			const w = maxX - minX + 1
			const h = maxY - minY + 1
			if (w < 10 || h < 10) continue
			const aspect = w / h
			const fill = area / (w * h)
			if (aspect < 0.8 || aspect > 1.25 || fill < 0.45) continue
			found.push({ x: minX, y: minY, w, h, cx: minX + w / 2, cy: minY + h / 2 })
		}

		return found
	}

	// The tokens of one board are all the same size: keep the biggest same-size group.
	function sameSizeGroup(tokens) {
		let best = []
		for (const t of tokens) {
			const group = tokens.filter(o => Math.abs(o.w - t.w) <= 0.15 * t.w)
			if (group.length > best.length) best = group
		}
		return best
	}

	// ---- lattice fit -------------------------------------------------------

	function assign(tokens, x0, y0, halfW, rowH, tolerance) {
		const slots = new Array(POSITIONS.length).fill(null)
		for (const t of tokens) {
			let bestSlot = -1, bestDist = Infinity
			for (let s = 0; s < POSITIONS.length; s++) {
				const dx = t.cx - (x0 + POSITIONS[s].col * halfW)
				const dy = t.cy - (y0 + POSITIONS[s].row * rowH)
				const d = Math.hypot(dx, dy)
				if (d < bestDist) { bestDist = d; bestSlot = s }
			}
			if (bestDist > tolerance) continue
			if (slots[bestSlot] === null || slots[bestSlot].dist > bestDist) {
				slots[bestSlot] = { token: t, dist: bestDist }
			}
		}
		return slots
	}

	function fitLine(pairs) {
		// least squares y = a + b * x
		const n = pairs.length
		let sx = 0, sy = 0, sxx = 0, sxy = 0
		for (const [x, y] of pairs) { sx += x; sy += y; sxx += x * x; sxy += x * y }
		const denom = n * sxx - sx * sx
		if (Math.abs(denom) < 1e-9) return null
		const b = (n * sxy - sx * sy) / denom
		return { a: (sy - b * sx) / n, b }
	}

	function fitLattice(tokens) {
		const size = tokens.reduce((s, t) => s + t.w, 0) / tokens.length
		const hexW = size / TOKEN_TO_HEX
		let halfW = hexW / 2
		let rowH = hexW * ROW_SPACING

		let best = null
		for (const anchor of tokens) {
			for (const pos of POSITIONS) {
				const x0 = anchor.cx - pos.col * halfW
				const y0 = anchor.cy - pos.row * rowH
				const slots = assign(tokens, x0, y0, halfW, rowH, 0.25 * hexW)
				let count = 0, err = 0
				for (const s of slots) if (s) { count++; err += s.dist }
				if (!best || count > best.count || (count === best.count && err < best.err)) {
					best = { count, err, x0, y0 }
				}
			}
		}
		if (!best || best.count < 8) return null

		// Refine pitch and origin from the matched tokens, then match again.
		let { x0, y0 } = best
		for (let pass = 0; pass < 2; pass++) {
			const slots = assign(tokens, x0, y0, halfW, rowH, 0.3 * hexW)
			const xs = [], ys = []
			slots.forEach((s, i) => {
				if (!s) return
				xs.push([POSITIONS[i].col, s.token.cx])
				ys.push([POSITIONS[i].row, s.token.cy])
			})
			const fx = fitLine(xs), fy = fitLine(ys)
			if (fx && fy && new Set(xs.map(p => p[0])).size > 2 && new Set(ys.map(p => p[0])).size > 2) {
				x0 = fx.a; halfW = fx.b; y0 = fy.a; rowH = fy.b
			}
		}
		const slots = assign(tokens, x0, y0, halfW, rowH, 0.3 * hexW)
		return { slots, hexW: halfW * 2 }
	}

	// ---- digit reading -----------------------------------------------------

	function inkAt(img, x, y) {
		const p = (y * img.width + x) * 4
		const d = (Math.abs(img.data[p] - TOKEN_RGB[0]) +
			Math.abs(img.data[p + 1] - TOKEN_RGB[1]) +
			Math.abs(img.data[p + 2] - TOKEN_RGB[2])) / 3
		return Math.min(1, d / 110)
	}

	// Ink image of the digit area of a token, cropped tight and resampled to GLYPH_W x GLYPH_H.
	function readGlyph(img, token) {
		const x0 = Math.round(token.x + token.w * 0.14)
		const x1 = Math.round(token.x + token.w * 0.86)
		const y0 = Math.round(token.y + token.h * 0.10)
		const y1 = Math.round(token.y + token.h * 0.70)

		let minX = x1, maxX = x0, minY = y1, maxY = y0, total = 0
		for (let y = y0; y < y1; y++) {
			for (let x = x0; x < x1; x++) {
				if (inkAt(img, x, y) > 0.5) {
					if (x < minX) minX = x
					if (x > maxX) maxX = x
					if (y < minY) minY = y
					if (y > maxY) maxY = y
					total++
				}
			}
		}
		if (total < 6) return null

		const bw = maxX - minX + 1
		const bh = maxY - minY + 1
		const glyph = new Float32Array(GLYPH_W * GLYPH_H)
		for (let gy = 0; gy < GLYPH_H; gy++) {
			for (let gx = 0; gx < GLYPH_W; gx++) {
				// average the ink over the source area that maps to this cell
				const sx0 = minX + (gx / GLYPH_W) * bw, sx1 = minX + ((gx + 1) / GLYPH_W) * bw
				const sy0 = minY + (gy / GLYPH_H) * bh, sy1 = minY + ((gy + 1) / GLYPH_H) * bh
				let sum = 0, weight = 0
				for (let y = Math.floor(sy0); y < Math.ceil(sy1); y++) {
					const wy = Math.min(y + 1, sy1) - Math.max(y, sy0)
					if (wy <= 0 || y < 0 || y >= img.height) continue
					for (let x = Math.floor(sx0); x < Math.ceil(sx1); x++) {
						const wx = Math.min(x + 1, sx1) - Math.max(x, sx0)
						if (wx <= 0 || x < 0 || x >= img.width) continue
						sum += inkAt(img, x, y) * wx * wy
						weight += wx * wy
					}
				}
				glyph[gy * GLYPH_W + gx] = weight > 0 ? sum / weight : 0
			}
		}
		return { glyph, aspect: bw / bh }
	}

	function distance(a, b) {
		let s = 0
		for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d }
		return Math.sqrt(s / a.length)
	}

	function classify(glyph) {
		let best = null, second = Infinity
		for (const value of Object.keys(GLYPH_TEMPLATES)) {
			const d = distance(glyph, GLYPH_TEMPLATES[value])
			if (!best || d < best.dist) {
				if (best) second = best.dist
				best = { value: Number(value), dist: d }
			} else if (d < second) second = d
		}
		if (!best) return null
		// confidence: how much better the winner is than the runner-up
		best.margin = second === Infinity ? 1 : (second - best.dist) / Math.max(second, 1e-6)
		return best
	}

	// ---- public API --------------------------------------------------------

	function readBoard(img) {
		const warnings = []
		const fail = message => ({ ok: false, error: message, values: null, uncertain: [], warnings })

		const tokens = sameSizeGroup(findTokens(img))
		if (tokens.length < 8) return fail('Could not find the number tokens. Paste a screenshot of the whole board.')

		const lattice = fitLattice(tokens)
		if (!lattice) return fail('Found number tokens but they do not form a standard 19-hex board.')

		const values = new Array(POSITIONS.length).fill(null)
		const uncertain = []
		const missing = []

		lattice.slots.forEach((slot, i) => {
			if (!slot) { missing.push(i); return }
			const g = readGlyph(img, slot.token)
			const result = g && classify(g.glyph)
			if (!result) { uncertain.push(i); return }
			values[i] = result.value
			if (result.margin < 0.12) uncertain.push(i)
		})

		// One empty slot is the desert; any more means a token is hidden (robber, piece, UI).
		if (missing.length === 1) {
			values[missing[0]] = 0
		} else {
			for (const i of missing) uncertain.push(i)
			if (missing.length > 1) warnings.push(missing.length + ' hexes had no visible number token (hidden by the robber or a piece?).')
		}

		const counts = {}
		for (const v of values) if (v) counts[v] = (counts[v] || 0) + 1
		const unexpected = Object.keys(STANDARD_COUNTS).some(k => (counts[k] || 0) !== STANDARD_COUNTS[k])
		if (unexpected && !uncertain.length) {
			warnings.push('The numbers do not match a standard board (2 and 12 once, the rest twice). Double-check them.')
		}

		return { ok: true, values, uncertain: Array.from(new Set(uncertain)).sort((a, b) => a - b), warnings }
	}

	const api = { readBoard, findTokens, fitLattice, readGlyph, classify, GLYPH_W, GLYPH_H, setTemplates: t => { GLYPH_TEMPLATES = t } }
	if (typeof module !== 'undefined' && module.exports) module.exports = api
	else root.BoardReader = api

	// BEGIN GENERATED TEMPLATES (ink grids of each number, built from a colonist.io screenshot)
	GLYPH_TEMPLATES = {
		2: Array.from('135899999863100058999999999851009999999999999610799999999999995149999999999999932999999999999997299999999999999917853347999999990210000279999999000000016999999900000002799999990000000499999999000000279999999300000269999999710000279999999720001489999999720025899999999832228999999999999888999999999999999999999999999999999999999999999999999999999999999999999999999999985566677788889995', Number).map(d => d / 9),
		3: Array.from('001357888742000014799999999851003899999999999510499999999999995039999999999999822899999999999994169999999999999605852112699999980220000038999996000000016999999400003678999999720001599999999950000159999999997200016999999999940001577899999998110012126999999937410000289999994998643479999999599999999999999779999999999999948999999999999982899999999999994058999999999995101369999999974100', Number).map(d => d / 9),
		4: Array.from('000000003899999300111111599999930156666459999993038999966999999304999996699999930599999569999993159999836999999317999982699999922899998169999992299999716999999239999961799999924999994279999994699999989999999989999999999999999999999999999999999999999999999988887778999999861111111499999961000000039999996100000003999999610000000499999961000000049999995100000004999999500000000499987630', Number).map(d => d / 9),
		5: Array.from('047777777788873016999999999998401699999999999940169999999999994016999999999999501799999999999950189999867778884028999961122222102899997233321000289999988887520029999999999986202999999999999961299999999999998526555678999999970111111369999998210000004999999977532223899999998998877899999998999999999999999799999999999999949999999999999971999999999999983078999999999963001357899998741000', Number).map(d => d / 9),
		6: Array.from('000002467776520000014799999997200015899999999930004999999999993002899999999998200599999999999820279999998778981039999995222346105999995001100100799998334554310089999868999985108999999999999951899999999999999499999999999999978999999656999999899999610179999979999940005999996999997212799999499999976799999728999999999999951599999999999982027999999999994000389999999996100003799999985100', Number).map(d => d / 9),
		8: Array.from('000124566532000000157999999741000169999999998510169999999999984039999999999999725999999999999993799999755899999479999710028999945999950000799993399997100289998217999974579999510499999999999820169999999999995149999998899999948999984125999998999996000179999999999600017999999999984225999999999999988999999979999999999999973899999999999983048999999999985101479999999974100002467887642000', Number).map(d => d / 9),
		9: Array.from('000135788752100000168999999851000169999999999500159999999999983039999999999999716999999999999993899999656999999599999710169999989999960004999999999998323799999989999987899999995999999999999999279999999999999903799999999999980025788756999997000012211599999503632111499999930599876799999971169999999999995017999999999998202899999999999400289999999999610016999999998510000246889986310000', Number).map(d => d / 9),
		10: Array.from('016765100135300004999910059984001899991039999820699998107999995089999812999999818999981599999993699998179999999649999818999999972889982999638999147998399930699901799849981039990079984998002999007997499700299900799749970029990079973998002999007997399910499900799719994179980079971899859997007997079999999500799705999999920079960199999971007996006999994000799600289997100057850004898300', Number).map(d => d / 9),
		11: Array.from('003887740027877602899997016999991799999716999999699999974999999999999997899999988999999669999998799999964999999849999996299999982979999607799998053999960438999801299996011899980029999500089997002999950008999700299995000899970039999400089997003999940008999700399993000899970039999300189997003999930018999600399993001899960039999300189996003999930018999600399992001899950025677200056774', Number).map(d => d / 9),
		12: Array.from('001222101477410000588861699996100399998399999940289999839999998169999982999999937999998189999996699999818999999839999980765899992999997031049999176999700003999902499960000399990049996000049998004999500006999600499950002999930049995001799971004999501599993000499951699997320049995599999998004999569999999900499956999999980049995699999997004999469999999600499945999999960026783134455664', Number).map(d => d / 9),
	}
	// END GENERATED TEMPLATES
})(typeof self !== 'undefined' ? self : this)
