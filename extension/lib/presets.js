export function collectPresets(rows, active) {
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
    const activeRow = active ? rows.find(row => row.savedName === active) : undefined;
    const followsRename = activeRow && owners.get(activeRow.name) === activeRow;
    return {
        presets: [...owners.values()].map(row => [row.name, row.percent]),
        saved: [...owners.values()],
        duplicates,
        active: followsRename ? activeRow.name : active,
    };
}
