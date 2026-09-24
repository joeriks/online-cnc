import { simulate } from './core/simulate.js';

self.onmessage = (e) => {
  const { id, code, cfg } = e.data;
  try {
    const result = simulate(code, cfg, (p) => self.postMessage({ id, progress: p }));
    const c = result.chunks;
    const transfer = [result.finalHeights.buffer];
    for (const k of Object.keys(c)) if (c[k] && c[k].buffer) transfer.push(c[k].buffer);
    self.postMessage({ id, result }, transfer);
  } catch (err) {
    self.postMessage({ id, error: String((err && err.stack) || err) });
  }
};
