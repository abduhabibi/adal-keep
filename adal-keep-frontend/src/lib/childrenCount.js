/** Number of children: 0 unless a person wrote another number; a number she has is kept (backend services/childrenCount.js). */
export const childrenOrZero = (v) => (v === null || v === undefined || String(v).trim() === '' ? 0 : Number(v) || 0)
