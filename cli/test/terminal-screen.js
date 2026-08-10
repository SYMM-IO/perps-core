export function renderTerminalScreen(data, { columns = 100, rows = 32 } = {}) {
	const blank = () => Array(columns).fill(" ");
	const screen = Array.from({ length: rows }, blank);
	let row = 0;
	let column = 0;
	let saved = { row: 0, column: 0 };

	const normalizeRow = () => {
		while (row >= rows) {
			screen.shift();
			screen.push(blank());
			row--;
		}
		row = Math.max(0, row);
		column = Math.max(0, Math.min(columns - 1, column));
	};
	const clearLine = (targetRow, start = 0, end = columns) => {
		for (let index = Math.max(0, start); index < Math.min(columns, end); index++) screen[targetRow][index] = " ";
	};
	const parameter = (parts, index, fallback = 1) => {
		const value = Number(parts[index]);
		return Number.isFinite(value) && value > 0 ? value : fallback;
	};

	for (let index = 0; index < data.length; ) {
		const character = data[index];
		if (character === "\x1b" && data[index + 1] === "[") {
			let end = index + 2;
			while (end < data.length && !/[@-~]/.test(data[end])) end++;
			if (end >= data.length) break;
			const final = data[end];
			const raw = data.slice(index + 2, end).replace(/^\?/, "");
			const parts = raw.split(";");
			const first = parts[0] === "" ? 0 : Number(parts[0]);
			if (final === "A") row -= parameter(parts, 0);
			else if (final === "B") row += parameter(parts, 0);
			else if (final === "C") column += parameter(parts, 0);
			else if (final === "D") column -= parameter(parts, 0);
			else if (final === "G") column = parameter(parts, 0) - 1;
			else if (final === "H" || final === "f") {
				row = parameter(parts, 0) - 1;
				column = parameter(parts, 1) - 1;
			} else if (final === "J") {
				if (first === 2 || first === 3) for (let target = 0; target < rows; target++) clearLine(target);
				else {
					clearLine(row, column);
					for (let target = row + 1; target < rows; target++) clearLine(target);
				}
			} else if (final === "K") {
				if (first === 1) clearLine(row, 0, column + 1);
				else if (first === 2) clearLine(row);
				else clearLine(row, column);
			} else if (final === "s") saved = { row, column };
			else if (final === "u") ({ row, column } = saved);
			normalizeRow();
			index = end + 1;
			continue;
		}
		if (character === "\x1b" && data[index + 1] === "]") {
			let end = index + 2;
			while (end < data.length && data[end] !== "\x07" && !(data[end] === "\x1b" && data[end + 1] === "\\")) end++;
			index = data[end] === "\x07" ? end + 1 : end + 2;
			continue;
		}
		if (character === "\r") column = 0;
		else if (character === "\n") row++;
		else if (character === "\b") column--;
		else if (character >= " ") {
			const codePoint = data.codePointAt(index);
			const printable = String.fromCodePoint(codePoint);
			if (column >= columns) {
				column = 0;
				row++;
			}
			normalizeRow();
			screen[row][column++] = printable;
			index += printable.length;
			continue;
		}
		normalizeRow();
		index++;
	}
	return screen
		.map(line => line.join("").replace(/\s+$/u, ""))
		.join("\n")
		.replace(/\n+$/u, "");
}
