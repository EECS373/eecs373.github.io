const MAX_TRIANGLES = 300_000;
const NUMBER = '[+-]?(?:\\d+\\.?\\d*|\\.\\d+)(?:[eE][+-]?\\d+)?';

/** Read an STL without changing its original bytes or its X/Y/Z coordinate system. */
export function parseSTL(input) {
  let buffer;
  if (input instanceof ArrayBuffer) buffer = input;
  else if (ArrayBuffer.isView(input)) buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength);
  else throw new Error('Could not read this STL file.');
  if (buffer.byteLength < 15) throw new Error('This STL file is empty or incomplete.');

  const view = new DataView(buffer);
  const binaryCount = buffer.byteLength >= 84 ? view.getUint32(80, true) : 0;
  let positions;
  if (binaryCount > 0 && 84 + binaryCount * 50 === buffer.byteLength) {
    if (binaryCount > MAX_TRIANGLES) throw new Error('The STL preview supports up to 300,000 triangles.');
    positions = new Float32Array(binaryCount * 9);
    for (let triangle = 0; triangle < binaryCount; triangle++) {
      const offset = 84 + triangle * 50 + 12;
      for (let coordinate = 0; coordinate < 9; coordinate++) {
        positions[triangle * 9 + coordinate] = view.getFloat32(offset + coordinate * 4, true);
      }
    }
  } else {
    let text;
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buffer).trim(); }
    catch { throw new Error('The binary STL file is incomplete or has an invalid triangle count.'); }
    if (!/^solid(?:\s|$)/i.test(text) || !/\bendsolid(?:\s|$)/i.test(text)) {
      throw new Error('This file is not a valid ASCII or binary STL.');
    }
    const facets = text.matchAll(/\bfacet\s+normal\b([\s\S]*?)\bendfacet\b/gi);
    const vertex = new RegExp(`\\bvertex\\s+(${NUMBER})\\s+(${NUMBER})\\s+(${NUMBER})(?=\\s|$)`, 'gi');
    const values = [];
    let triangles = 0;
    for (const facet of facets) {
      const points = [...facet[1].matchAll(vertex)];
      if (points.length !== 3) throw new Error('Each STL facet must contain three vertices.');
      if (++triangles > MAX_TRIANGLES) throw new Error('The STL preview supports up to 300,000 triangles.');
      for (const point of points) values.push(Number(point[1]), Number(point[2]), Number(point[3]));
    }
    if (triangles !== (text.match(/\bendfacet\b/gi) || []).length || triangles !== (text.match(/\bfacet\s+normal\b/gi) || []).length) {
      throw new Error('This STL contains an incomplete facet.');
    }
    positions = new Float32Array(values);
  }
  if (!positions.length || positions.length % 9 !== 0) throw new Error('This STL contains no complete triangles.');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let coordinate = 0; coordinate < positions.length; coordinate++) {
    const value = positions[coordinate], axis = coordinate % 3;
    if (!Number.isFinite(value)) throw new Error('This STL contains an invalid coordinate.');
    min[axis] = Math.min(min[axis], value);
    max[axis] = Math.max(max[axis], value);
  }
  const bounds = max.map((value, axis) => value - min[axis]);
  if (!(Math.max(...bounds) > 0)) throw new Error('This STL contains no measurable geometry.');
  return { positions, bounds, triangleCount: positions.length / 9 };
}

const VERTEX_SHADER = `
  attribute vec3 position;
  attribute vec3 normal;
  uniform float yaw;
  uniform float pitch;
  uniform float aspect;
  varying vec3 surfaceNormal;
  vec3 rotate(vec3 p) {
    float c = cos(yaw), s = sin(yaw);
    p = vec3(c*p.x+s*p.z, p.y, -s*p.x+c*p.z);
    c = cos(pitch); s = sin(pitch);
    return vec3(p.x, c*p.y-s*p.z, s*p.y+c*p.z);
  }
  void main() {
    vec3 p = rotate(position);
    float fit = .96 * min(aspect, 1.0);
    gl_Position = vec4(p.x*fit/aspect, p.y*fit, -p.z*.25, 1.0);
    surfaceNormal = rotate(normal);
  }
`;
const FRAGMENT_SHADER = `
  precision mediump float;
  uniform vec3 color;
  varying vec3 surfaceNormal;
  void main() {
    float light = .48 + .52 * abs(dot(normalize(surfaceNormal + vec3(.0001)), normalize(vec3(.3,.85,1.0))));
    gl_FragColor = vec4(color * light, 1.0);
  }
`;

/** A dependency-free STL viewer. Parser dimensions remain in the STL's own units. */
export class STLViewer {
  constructor(canvas, { onUnavailable } = {}) {
    this.canvas = canvas;
    this.onUnavailable = typeof onUnavailable === 'function' ? onUnavailable : () => {};
    this.available = false;
    this.disposed = false;
    this.geometry = null;
    this.meshCount = 0;
    this.color = [.58, .64, .69];
    this.yaw = -.49;
    this.pitch = -.37;
    this.listeners = [];
    this.media = globalThis.matchMedia?.('(prefers-color-scheme: dark)');
    this._themeChange = () => this.draw();
    this.media?.addEventListener('change', this._themeChange);
    try {
      this.gl = canvas.getContext('webgl', { antialias: true, alpha: false });
      if (!this.gl) throw new Error('3D preview is unavailable in this browser.');
      this._initialize();
      this.available = true;
    } catch (error) {
      this._releaseGL();
      this.onUnavailable(error.message || '3D preview is unavailable in this browser.');
    }
    this._listen('webglcontextlost', event => {
      event.preventDefault();
      this.available = false;
      this.drag = null;
      this.onUnavailable('3D preview was interrupted. Reload the page to restore it.');
    });
    this._listen('pointerdown', event => {
      if (event.button !== 0 || this.drag) return;
      this.drag = { id: event.pointerId, x: event.clientX, y: event.clientY, yaw: this.yaw, pitch: this.pitch };
      try { this.canvas.setPointerCapture(event.pointerId); } catch { /* Pointer may already have ended. */ }
    });
    this._listen('pointermove', event => {
      if (!this.drag || this.drag.id !== event.pointerId) return;
      this.yaw = this.drag.yaw + (event.clientX - this.drag.x) * .012;
      this.pitch = Math.max(-1.3, Math.min(1.3, this.drag.pitch + (event.clientY - this.drag.y) * .012));
      this.draw();
    });
    const endDrag = event => { if (this.drag?.id === event.pointerId) this.drag = null; };
    this._listen('pointerup', endDrag);
    this._listen('pointercancel', endDrag);
    this._listen('lostpointercapture', endDrag);
    this.originalTouchAction = canvas.style.touchAction;
    canvas.style.touchAction = 'none';
    if (typeof globalThis.ResizeObserver === 'function') {
      this.observer = new ResizeObserver(() => this.resize());
      this.observer.observe(canvas);
    }
    this.resize();
  }

  _listen(type, listener) {
    this.canvas.addEventListener(type, listener);
    this.listeners.push([type, listener]);
  }

  _initialize() {
    const gl = this.gl;
    const compile = (type, source) => {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Could not start the 3D preview.');
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
        gl.deleteShader(shader);
        throw new Error('Could not start the 3D preview.');
      }
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, VERTEX_SHADER);
    let fragment;
    try { fragment = compile(gl.FRAGMENT_SHADER, FRAGMENT_SHADER); }
    catch (error) { gl.deleteShader(vertex); throw error; }
    const program = gl.createProgram();
    if (!program) { gl.deleteShader(vertex); gl.deleteShader(fragment); throw new Error('Could not start the 3D preview.'); }
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    gl.deleteShader(vertex);
    gl.deleteShader(fragment);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      throw new Error('Could not start the 3D preview.');
    }
    this.program = program;
    this.meshBuffer = gl.createBuffer();
    this.gridBuffer = gl.createBuffer();
    if (!this.meshBuffer || !this.gridBuffer) throw new Error('Could not start the 3D preview.');
    this.attributes = { position: gl.getAttribLocation(program, 'position'), normal: gl.getAttribLocation(program, 'normal') };
    this.uniforms = Object.fromEntries(['yaw', 'pitch', 'aspect', 'color'].map(name => [name, gl.getUniformLocation(program, name)]));
    this._setGrid(-.72);
  }

  _setGrid(height) {
    if (!this.gl || !this.gridBuffer) return;
    const points = [];
    for (let index = -5; index <= 5; index++) {
      const p = index * .2;
      points.push(-1, height, p, 0, 1, 0, 1, height, p, 0, 1, 0, p, height, -1, 0, 1, 0, p, height, 1, 0, 1, 0);
    }
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.gridBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, new Float32Array(points), this.gl.STATIC_DRAW);
    this.gridCount = points.length / 6;
  }

  setModel(geometry) {
    this.geometry = geometry;
    this.meshCount = 0;
    if (!geometry) { this._setGrid(-.72); this.draw(); return this; }
    const raw = geometry.positions;
    if (!(raw instanceof Float32Array) || !raw.length || raw.length % 9 !== 0) throw new Error('Could not preview this STL geometry.');
    const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
    for (let index = 0; index < raw.length; index++) {
      const value = raw[index], axis = index % 3;
      if (!Number.isFinite(value)) throw new Error('Could not preview an invalid STL coordinate.');
      min[axis] = Math.min(min[axis], value);
      max[axis] = Math.max(max[axis], value);
    }
    const dimensions = max.map((value, axis) => value - min[axis]);
    const radius = Math.hypot(...dimensions) / 2;
    if (!(radius > 0) || !Number.isFinite(radius)) throw new Error('This STL contains no measurable geometry.');
    const center = min.map((value, axis) => (value + max[axis]) / 2), scale = .78 / radius;
    if (!this.available) return this;
    const interleaved = new Float32Array(raw.length * 2);
    for (let index = 0; index < raw.length; index += 9) {
      const ax = raw[index + 3] - raw[index], ay = raw[index + 4] - raw[index + 1], az = raw[index + 5] - raw[index + 2];
      const bx = raw[index + 6] - raw[index], by = raw[index + 7] - raw[index + 1], bz = raw[index + 8] - raw[index + 2];
      let nx = ay * bz - az * by, ny = az * bx - ax * bz, nz = ax * by - ay * bx;
      const length = Math.hypot(nx, ny, nz);
      if (length > 0) { nx /= length; ny /= length; nz /= length; }
      else { nx = 0; ny = 0; nz = 1; }
      for (let vertex = 0; vertex < 9; vertex += 3) {
        const output = (index + vertex) * 2;
        interleaved[output] = (raw[index + vertex] - center[0]) * scale;
        interleaved[output + 1] = (raw[index + vertex + 2] - center[2]) * scale;
        interleaved[output + 2] = -(raw[index + vertex + 1] - center[1]) * scale;
        interleaved[output + 3] = nx;
        interleaved[output + 4] = nz;
        interleaved[output + 5] = -ny;
      }
    }
    this.meshCount = raw.length / 3;
    this.gl.bindBuffer(this.gl.ARRAY_BUFFER, this.meshBuffer);
    this.gl.bufferData(this.gl.ARRAY_BUFFER, interleaved, this.gl.STATIC_DRAW);
    this._setGrid((min[2] - center[2]) * scale - .04);
    this.draw();
    return this;
  }

  setColor(value) {
    let hex = typeof value === 'string' ? value.trim() : '';
    if (/^#[a-f\d]{3}$/i.test(hex)) hex = '#' + [...hex.slice(1)].map(character => character + character).join('');
    if (!/^#[a-f\d]{6}$/i.test(hex)) hex = '#94a2af';
    this.color = [1, 3, 5].map(index => parseInt(hex.slice(index, index + 2), 16) / 255);
    this.draw();
    return this;
  }

  setYaw(degrees) {
    if (Number.isFinite(Number(degrees))) this.yaw = Number(degrees) * Math.PI / 180;
    this.draw();
    return this;
  }

  reset() { this.yaw = -.49; this.pitch = -.37; this.draw(); return this; }

  resize() {
    if (this.disposed) return;
    const width = this.canvas.clientWidth, height = this.canvas.clientHeight;
    if (!(width > 0) || !(height > 0)) return;
    const ratio = Math.min(globalThis.devicePixelRatio || 1, 2);
    const outputWidth = Math.max(1, Math.round(width * ratio)), outputHeight = Math.max(1, Math.round(height * ratio));
    if (this.canvas.width !== outputWidth) this.canvas.width = outputWidth;
    if (this.canvas.height !== outputHeight) this.canvas.height = outputHeight;
    if (this.available) this.gl.viewport(0, 0, outputWidth, outputHeight);
    this.draw();
  }

  draw() {
    if (!this.available || this.disposed || !this.canvas.width || !this.canvas.height) return;
    const gl = this.gl, dark = !!this.media?.matches;
    const background = dark ? [.094, .157, .227] : [.91, .933, .953];
    gl.clearColor(...background, 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.useProgram(this.program);
    gl.uniform1f(this.uniforms.yaw, this.yaw);
    gl.uniform1f(this.uniforms.pitch, this.pitch);
    gl.uniform1f(this.uniforms.aspect, this.canvas.width / this.canvas.height);
    const bind = buffer => {
      gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
      gl.enableVertexAttribArray(this.attributes.position);
      gl.vertexAttribPointer(this.attributes.position, 3, gl.FLOAT, false, 24, 0);
      gl.enableVertexAttribArray(this.attributes.normal);
      gl.vertexAttribPointer(this.attributes.normal, 3, gl.FLOAT, false, 24, 12);
    };
    bind(this.gridBuffer);
    gl.uniform3f(this.uniforms.color, ...(dark ? [.25, .34, .44] : [.64, .71, .77]));
    gl.drawArrays(gl.LINES, 0, this.gridCount);
    if (this.meshCount) {
      bind(this.meshBuffer);
      gl.uniform3f(this.uniforms.color, ...this.color);
      gl.drawArrays(gl.TRIANGLES, 0, this.meshCount);
    }
  }

  _releaseGL() {
    if (!this.gl) return;
    if (this.meshBuffer) this.gl.deleteBuffer(this.meshBuffer);
    if (this.gridBuffer) this.gl.deleteBuffer(this.gridBuffer);
    if (this.program) this.gl.deleteProgram(this.program);
    this.meshBuffer = null; this.gridBuffer = null; this.program = null;
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.available = false;
    this.observer?.disconnect();
    this.media?.removeEventListener('change', this._themeChange);
    for (const [type, listener] of this.listeners) this.canvas.removeEventListener(type, listener);
    this.canvas.style.touchAction = this.originalTouchAction;
    this._releaseGL();
    this.geometry = null;
  }
}
