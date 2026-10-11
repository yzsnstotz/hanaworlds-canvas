// Fixed, explicitly labelled demonstration. Never written to Canvas or a world.
export const displayFixture = {
  state: 'READY', worldRef: 'example-world',
  objects: [
    { objectRef: 'example-house', name: '林边小屋', occupiedCells: 384,
      bounds: { min: [12, 4, 8], max: [19, 9, 15], size: [8, 6, 8] } },
    { objectRef: 'example-path', name: '石头小径', occupiedCells: 0, bounds: null },
  ],
  history: [
    { transactionId: 'example-build-house', objectRef: 'example-house', objectName: '林边小屋',
      sequence: 1, committedAt: '2026-10-07T08:00:00.000Z', mode: 'REGION', affectedCells: 384, status: 'COMMITTED' },
    { transactionId: 'example-build-path', objectRef: 'example-path', objectName: '石头小径',
      sequence: 1, committedAt: '2026-10-07T08:02:00.000Z', mode: 'CELL', affectedCells: 24, status: 'UNDONE' },
    { transactionId: 'example-undo-path', objectRef: 'example-path', objectName: '石头小径',
      sequence: 2, committedAt: '2026-10-07T08:03:00.000Z', mode: 'CELL', affectedCells: 24, status: 'UNDONE' },
  ],
};
