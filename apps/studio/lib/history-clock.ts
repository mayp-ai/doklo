/**
 * Injectable clock for history entries. Server actions read
 * `historyClock.now()` at the moment a person saves, changes status, or
 * approves — the only places a wall clock is legitimate in this pipeline —
 * and tests pin it for deterministic dates.
 */
export const historyClock: { now: () => Date } = { now: () => new Date() };
