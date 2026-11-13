import { parseSTL } from './stl-viewer.js?v=20261112-model-previews';

export const MAX_PREVIEW_BYTES = 10 * 1024 * 1024;
const MAX_TRIANGLES = 300_000;
const meshExtensions = new Set(['.obj', '.3mf', '.amf']);
const stepExtensions = new Set(['.step', '.stp']);

const abortError = () => new DOMException('Preview cancelled.', 'AbortError');
export const supportsModelPreview = extension => extension === '.stl' || meshExtensions.has(extension) || stepExtensions.has(extension);

export function previewDimensions(geometry, unit) {
  const scale = unit === 'inch' ? 25.4 : 1;
  return geometry.bounds.map(value => value * scale);
}

function isGeometry(geometry) {
  const { positions, bounds, triangleCount } = geometry ?? {};
  return Number.isInteger(triangleCount) && triangleCount > 0 && triangleCount <= MAX_TRIANGLES &&
    positions instanceof Float32Array && positions.length === triangleCount * 9 &&
    Array.isArray(bounds) && bounds.length === 3 &&
    bounds.every(value => Number.isFinite(value) && value >= 0) && bounds.some(value => value > 0);
}

export async function decodeModelPreview(bytes, extension, { signal, wasmUrl, WorkerClass = globalThis.Worker } = {}) {
  if (signal?.aborted) throw abortError();
  if (!(bytes instanceof ArrayBuffer) || !bytes.byteLength) throw new Error('The model file is empty or unreadable.');
  if (bytes.byteLength > MAX_PREVIEW_BYTES) throw new Error('This file exceeds the 10 MB preview limit.');
  if (extension === '.stl') return parseSTL(bytes);
  if (!supportsModelPreview(extension) || !WorkerClass) throw new Error('3D preview is unavailable for this file.');
  const step = stepExtensions.has(extension);
  if (step && !wasmUrl) throw new Error('STEP preview is unavailable.');
  const url = step
    ? new URL('./step-preview-worker.js?v=20261112-model-previews', import.meta.url)
    : new URL('./mesh-preview-worker.js?v=20261112-model-previews', import.meta.url);

  return new Promise((resolve, reject) => {
    let worker, settled = false;
    function finish(error, geometry) {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', cancel);
      worker?.terminate();
      if (error) reject(error);
      else resolve(geometry);
    }
    const cancel = () => finish(abortError());
    try {
      worker = new WorkerClass(url);
      signal?.addEventListener('abort', cancel, {once:true});
      worker.onmessage = ({data}) => {
        if (typeof data?.error === 'string' && data.error) finish(new Error(data.error));
        else if (isGeometry(data?.geometry)) finish(null, data.geometry);
        else finish(new Error('The preview decoder returned invalid geometry.'));
      };
      worker.onerror = event => {
        event.preventDefault();
        finish(new Error('The preview decoder could not load this model.'));
      };
      worker.onmessageerror = () => finish(new Error('The preview decoder returned unreadable geometry.'));
      if (signal?.aborted) cancel();
      else worker.postMessage(step ? {bytes, extension, wasmUrl} : {bytes, extension}, [bytes]);
    } catch {
      finish(new Error('The preview decoder could not start.'));
    }
  });
}

export class ModelPreview {
  constructor({load, onState = () => {}, onModel = () => {}, clearModel = () => {}, disposeViewer = () => {},
    wasmUrl, parse = (bytes, context, signal) => decodeModelPreview(bytes, context.extension, {signal, wasmUrl}), timeout = 30000}) {
    Object.assign(this, {load, onState, onModel, clearModel, disposeViewer, parse, timeout});
    this.sequence = 0;
    this.controller = null;
    this.timer = null;
    this.disposed = false;
  }

  close() {
    this.sequence++;
    clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort();
    this.controller = null;
    this.clearModel();
    this.onState({status:'idle'});
  }

  async open(context) {
    if (this.disposed) return;
    this.close();
    const sequence = this.sequence;
    const controller = new AbortController();
    const current = () => sequence === this.sequence && !this.disposed;
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(), this.timeout);
    this.timer = timer;
    try {
      this.onState({status:'loading', context});
      const buffer = await this.load(context, controller.signal);
      if (!current()) return;
      if (controller.signal.aborted) throw abortError();
      const geometry = await this.parse(buffer, context, controller.signal);
      if (!current()) return;
      if (controller.signal.aborted) throw abortError();
      this.onModel(geometry, context);
      if (!current()) return;
      this.onState({status:'ready', context, dimensions:previewDimensions(geometry, context.part.unit), triangleCount:geometry.triangleCount});
    } catch (error) {
      if (!current()) return;
      this.clearModel();
      const message = controller.signal.aborted ? 'Preview timed out.' : error.message || '3D preview is unavailable.';
      this.onState({status:'error', context, message});
    } finally {
      clearTimeout(timer);
      if (this.timer === timer) this.timer = null;
      if (current()) this.controller = null;
    }
  }

  dispose() {
    if (this.disposed) return;
    this.close();
    this.disposed = true;
    this.disposeViewer();
  }
}
