import test from 'node:test';
import assert from 'node:assert/strict';
import { qrSvg } from '../frontend/qr.js';

test('el QR de entrada se genera localmente con zona de silencio y no requiere un servicio remoto',()=>{
  const svg=qrSvg('token-temporal-de-prueba-con-contenido-suficiente');
  assert.match(svg,/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="37" height="37" viewBox="0 0 37 37"/);
  assert.match(svg,/<rect width="100%" height="100%" fill="#fff"\/>/);
  assert.match(svg,/<path d="M/);
  assert.doesNotMatch(svg,/https?:\/\/(?!www\.w3\.org)/);
  assert.throws(()=>qrSvg('x'.repeat(272)),/capacidad/);
});
