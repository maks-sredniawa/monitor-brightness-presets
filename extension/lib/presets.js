export function collectPresets(rows, activeRow) {
    const owners = new Map();
    const duplicates = new Set();
    for (const row of rows) {
        if (!row.name)
            continue;
        if (owners.has(row.name))
            duplicates.add(row);
        else
            owners.set(row.name, row);
    }
    return {
        presets: [...owners.values()].map(row => [row.name, row.percent]),
        saved: [...owners.values()],
        duplicates,
        active: activeRow && owners.get(activeRow.name) === activeRow ? activeRow.name : '',
    };
}
