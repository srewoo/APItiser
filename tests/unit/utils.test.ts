import { describe, expect, it } from 'vitest';
import { chunkArray } from '@background/utils/chunks';
import { createId } from '@background/utils/id';

// ---------------------------------------------------------------------------
// chunkArray
// ---------------------------------------------------------------------------

describe('chunkArray', () => {
  it('splits an array into equal-sized chunks', () => {
    expect(chunkArray([1, 2, 3, 4, 5, 6], 2)).toEqual([[1, 2], [3, 4], [5, 6]]);
  });

  it('puts the remainder in the last chunk', () => {
    const result = chunkArray([1, 2, 3, 4, 5], 2);
    expect(result).toEqual([[1, 2], [3, 4], [5]]);
    expect(result).toHaveLength(3);
  });

  it('returns a single chunk containing the whole array when chunkSize >= length', () => {
    expect(chunkArray([1, 2, 3], 10)).toEqual([[1, 2, 3]]);
  });

  it('returns an empty array when input is empty', () => {
    expect(chunkArray([], 5)).toEqual([]);
  });

  it('returns a single chunk wrapping the whole array when chunkSize <= 0', () => {
    // chunkSize <= 0 guard returns [items]
    expect(chunkArray([1, 2, 3], 0)).toEqual([[1, 2, 3]]);
  });

  it('works with chunkSize of 1', () => {
    expect(chunkArray(['a', 'b', 'c'], 1)).toEqual([['a'], ['b'], ['c']]);
  });

  it('preserves element references (no deep clone)', () => {
    const obj = { x: 1 };
    const result = chunkArray([obj], 1);
    expect(result[0]![0]).toBe(obj);
  });
});

// ---------------------------------------------------------------------------
// createId
// ---------------------------------------------------------------------------

describe('createId', () => {
  it('returns a string prefixed with the given prefix', () => {
    const id = createId('job');
    expect(id).toMatch(/^job_/);
  });

  it('produces unique IDs on subsequent calls', () => {
    const ids = new Set(Array.from({ length: 20 }, () => createId('test')));
    expect(ids.size).toBe(20);
  });

  it('includes a timestamp-like numeric segment', () => {
    const id = createId('x');
    const parts = id.split('_');
    // Format: prefix _ timestamp _ hex
    expect(parts.length).toBeGreaterThanOrEqual(3);
    const timestamp = Number(parts[1]);
    expect(Number.isFinite(timestamp)).toBe(true);
    expect(timestamp).toBeGreaterThan(0);
  });

  it('works with different prefixes', () => {
    expect(createId('batch')).toMatch(/^batch_/);
    expect(createId('artifact')).toMatch(/^artifact_/);
  });
});
