import { describe, expect, it } from 'vitest';
import * as main from '../src/index.js';

describe('the main entry', () => {
  it('exports configure, which `node ace add` and `node ace configure` call', () => {
    expect(typeof main.configure).toBe('function');
  });
});
