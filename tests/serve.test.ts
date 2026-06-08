import { describe, it, expect } from 'vitest';
import { rojoServePort, serveUrl } from '../src/sync/serve.js';

describe('rojoServePort', () => {
  it('defaults to 34872', () => {
    const prev = process.env.BLOX_ROJO_SERVE_PORT;
    delete process.env.BLOX_ROJO_SERVE_PORT;
    try { expect(rojoServePort()).toBe(34872); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_PORT = prev; }
  });

  it('honors BLOX_ROJO_SERVE_PORT', () => {
    const prev = process.env.BLOX_ROJO_SERVE_PORT;
    process.env.BLOX_ROJO_SERVE_PORT = '40000';
    try { expect(rojoServePort()).toBe(40000); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_PORT; else process.env.BLOX_ROJO_SERVE_PORT = prev; }
  });
});

describe('serveUrl', () => {
  it('builds a localhost url from the port', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    delete process.env.BLOX_ROJO_SERVE_URL;
    try { expect(serveUrl(40000)).toBe('http://localhost:40000'); }
    finally { if (prev !== undefined) process.env.BLOX_ROJO_SERVE_URL = prev; }
  });

  it('honors BLOX_ROJO_SERVE_URL override regardless of port', () => {
    const prev = process.env.BLOX_ROJO_SERVE_URL;
    process.env.BLOX_ROJO_SERVE_URL = 'http://172.30.12.182:34872';
    try { expect(serveUrl(40000)).toBe('http://172.30.12.182:34872'); }
    finally { if (prev === undefined) delete process.env.BLOX_ROJO_SERVE_URL; else process.env.BLOX_ROJO_SERVE_URL = prev; }
  });
});
