/**
 * The offline sketch runtime: a tiny 3D/animation helper library that the
 * document builder INLINES into every sketch `srcdoc`.
 *
 * WHY THIS EXISTS
 * ---------------
 * The sketch sandbox sets `connect-src 'none'` and `default-src 'none'`, so a
 * sketch cannot fetch a library — not from a CDN, not from disk, not ever.
 * Before this file, "you can do anything you can do with Three.js" was false:
 * the only surface was raw canvas/SVG/CSS plus hand-rolled WebGL.
 *
 * WHY NOT VENDOR THREE.JS
 * -----------------------
 * three.min.js is ~600 KB minified (~150 KB gzipped, but `srcdoc` is not
 * gzipped — it is a DOM string attribute, so the raw bytes are what the parser
 * and the IPC payload carry). Inlining it would mean ~600 KB of script parsed
 * on EVERY sketch revision, for sketches that mostly want a spinning wireframe.
 * It also drags in a large API surface the diagrammer model would have to
 * remember correctly with no docs to consult offline.
 *
 * So: NO new npm dependency was added. This runtime is ~8 KB of hand-written
 * MIT-equivalent (first-party) code covering the 90% case — an animation loop
 * with DPR-correct sizing, a WebGL program/attribute/uniform helper, 4x4/3-vec
 * math, three parametric geometries, a lit forward renderer, and an orbit
 * camera. Everything a sketch needs to be a hologram rather than a poster,
 * with none of the payload cost.
 *
 * BUDGET
 * ------
 * This string is injected by `buildSketchDocument` ALONGSIDE the model's HTML,
 * so it does NOT count against MAX_SKETCH_HTML_BYTES. The model's 128 KiB
 * budget stays entirely the model's.
 *
 * SECURITY
 * --------
 * The runtime touches only `document`, `window.requestAnimationFrame` and
 * WebGL — all of which already exist inside the opaque-origin sandbox. It
 * performs NO network access of any kind (no fetch/XHR/WebSocket/Worker/
 * importScripts), so it cannot widen the CSP's `connect-src 'none'`. It is
 * frozen and installed on `window.Sketch` before the model's markup runs.
 */

/** Bump when the runtime API changes; exposed to sketches as Sketch.version. */
export const SKETCH_RUNTIME_VERSION = 1

/**
 * The runtime source, as it is inlined. Written as one string (not compiled
 * from a separate module) so that what the tests assert about is byte-for-byte
 * what ships inside the srcdoc.
 */
export const SKETCH_RUNTIME_JS = `(function(){
"use strict";
var W = window, D = document;
function hasGL(c){ try { return !!(c.getContext("webgl") || c.getContext("experimental-webgl")); } catch(e){ return false; } }

/* ---- element helpers ---- */
function fullscreenCanvas(){
  var c = D.getElementById("sketch-canvas");
  if(!c){ c = D.createElement("canvas"); c.id = "sketch-canvas"; D.body.appendChild(c); }
  c.style.width = "100%"; c.style.height = "100%"; c.style.display = "block";
  return c;
}
function fit(canvas){
  var dpr = Math.min(W.devicePixelRatio || 1, 2);
  var w = canvas.clientWidth || W.innerWidth || 300;
  var h = canvas.clientHeight || W.innerHeight || 150;
  var nw = Math.max(1, Math.floor(w * dpr)), nh = Math.max(1, Math.floor(h * dpr));
  if(canvas.width !== nw || canvas.height !== nh){ canvas.width = nw; canvas.height = nh; return true; }
  return false;
}

/* ---- animation loop ---- */
function loop(fn){
  var raf = 0, stopped = false, t0 = (W.performance && W.performance.now ? W.performance.now() : Date.now()), prev = t0;
  function frame(now){
    if(stopped){ return; }
    var dt = (now - prev) / 1000; prev = now;
    if(dt > 0.25){ dt = 0.25; }
    try { fn({ t: (now - t0) / 1000, dt: dt }); }
    catch(err){ stopped = true; report(err); return; }
    raf = W.requestAnimationFrame(frame);
  }
  raf = W.requestAnimationFrame(frame);
  var handle = { stop: function(){ stopped = true; W.cancelAnimationFrame(raf); } };
  W.addEventListener("pagehide", handle.stop);
  return handle;
}

function report(err){
  var box = D.getElementById("sketch-error");
  if(!box){
    box = D.createElement("pre"); box.id = "sketch-error";
    box.style.cssText = "position:fixed;left:0;right:0;bottom:0;margin:0;padding:8px 10px;"
      + "font:12px ui-monospace,monospace;white-space:pre-wrap;background:rgba(120,20,30,.92);color:#ffe9ec;z-index:9999";
    D.body.appendChild(box);
  }
  box.textContent = "sketch error: " + (err && err.message ? err.message : String(err));
}

/* ---- 4x4 matrix / vec3 math (column-major, WebGL order) ---- */
var M = {
  identity: function(){ return new Float32Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]); },
  multiply: function(a,b,out){
    out = out || new Float32Array(16);
    for(var c=0;c<4;c++){
      for(var r=0;r<4;r++){
        var s=0; for(var k=0;k<4;k++){ s += a[k*4+r] * b[c*4+k]; }
        out[c*4+r]=s;
      }
    }
    return out;
  },
  perspective: function(fovy, aspect, near, far){
    var f = 1 / Math.tan(fovy/2), nf = 1 / (near - far);
    return new Float32Array([f/aspect,0,0,0, 0,f,0,0, 0,0,(far+near)*nf,-1, 0,0,2*far*near*nf,0]);
  },
  lookAt: function(eye, target, up){
    var z = V.norm(V.sub(eye,target)), x = V.norm(V.cross(up,z)), y = V.cross(z,x);
    return new Float32Array([
      x[0],y[0],z[0],0, x[1],y[1],z[1],0, x[2],y[2],z[2],0,
      -V.dot(x,eye), -V.dot(y,eye), -V.dot(z,eye), 1
    ]);
  },
  translation: function(x,y,z){ var m=M.identity(); m[12]=x; m[13]=y; m[14]=z; return m; },
  scaling: function(x,y,z){ var m=M.identity(); m[0]=x; m[5]=y; m[10]=z; return m; },
  rotationX: function(a){ var m=M.identity(), c=Math.cos(a), s=Math.sin(a); m[5]=c;m[6]=s;m[9]=-s;m[10]=c; return m; },
  rotationY: function(a){ var m=M.identity(), c=Math.cos(a), s=Math.sin(a); m[0]=c;m[2]=-s;m[8]=s;m[10]=c; return m; },
  rotationZ: function(a){ var m=M.identity(), c=Math.cos(a), s=Math.sin(a); m[0]=c;m[1]=s;m[4]=-s;m[5]=c; return m; },
  compose: function(pos, rot, scale){
    var m = M.multiply(M.rotationY(rot[1]), M.rotationX(rot[0]));
    m = M.multiply(m, M.rotationZ(rot[2]));
    m = M.multiply(m, M.scaling(scale[0], scale[1], scale[2]));
    m[12]=pos[0]; m[13]=pos[1]; m[14]=pos[2];
    return m;
  },
  normalMatrix: function(m){ return new Float32Array([m[0],m[1],m[2], m[4],m[5],m[6], m[8],m[9],m[10]]); }
};
var V = {
  sub: function(a,b){ return [a[0]-b[0],a[1]-b[1],a[2]-b[2]]; },
  cross: function(a,b){ return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; },
  dot: function(a,b){ return a[0]*b[0]+a[1]*b[1]+a[2]*b[2]; },
  norm: function(a){ var l = Math.hypot(a[0],a[1],a[2]) || 1; return [a[0]/l,a[1]/l,a[2]/l]; }
};

/* ---- WebGL plumbing ---- */
function gl(canvas){
  canvas = canvas || fullscreenCanvas();
  var ctx = canvas.getContext("webgl", { antialias: true, alpha: true, premultipliedAlpha: true })
         || canvas.getContext("experimental-webgl");
  if(!ctx){ throw new Error("WebGL is unavailable in this sandbox"); }
  return ctx;
}
function shader(ctx, type, src){
  var s = ctx.createShader(type);
  ctx.shaderSource(s, src); ctx.compileShader(s);
  if(!ctx.getShaderParameter(s, ctx.COMPILE_STATUS)){
    throw new Error("shader: " + ctx.getShaderInfoLog(s));
  }
  return s;
}
function program(ctx, vsrc, fsrc){
  var p = ctx.createProgram();
  ctx.attachShader(p, shader(ctx, ctx.VERTEX_SHADER, vsrc));
  ctx.attachShader(p, shader(ctx, ctx.FRAGMENT_SHADER, fsrc));
  ctx.linkProgram(p);
  if(!ctx.getProgramParameter(p, ctx.LINK_STATUS)){
    throw new Error("link: " + ctx.getProgramInfoLog(p));
  }
  p.at = function(n){ return ctx.getAttribLocation(p, n); };
  p.un = function(n){ return ctx.getUniformLocation(p, n); };
  return p;
}
function buffer(ctx, data, target){
  var b = ctx.createBuffer();
  target = target || ctx.ARRAY_BUFFER;
  ctx.bindBuffer(target, b); ctx.bufferData(target, data, ctx.STATIC_DRAW);
  return b;
}

/* ---- geometry: {positions, normals, indices} ---- */
function boxGeometry(sx, sy, sz){
  sx=(sx||1)/2; sy=(sy===undefined?sx*2:sy)/2; sz=(sz===undefined?sx*2:sz)/2;
  var faces = [
    [[0,0,1],[[-1,-1,1],[1,-1,1],[1,1,1],[-1,1,1]]],
    [[0,0,-1],[[1,-1,-1],[-1,-1,-1],[-1,1,-1],[1,1,-1]]],
    [[1,0,0],[[1,-1,1],[1,-1,-1],[1,1,-1],[1,1,1]]],
    [[-1,0,0],[[-1,-1,-1],[-1,-1,1],[-1,1,1],[-1,1,-1]]],
    [[0,1,0],[[-1,1,1],[1,1,1],[1,1,-1],[-1,1,-1]]],
    [[0,-1,0],[[-1,-1,-1],[1,-1,-1],[1,-1,1],[-1,-1,1]]]
  ];
  var pos=[], nor=[], idx=[], n=0;
  for(var f=0; f<faces.length; f++){
    var nrm = faces[f][0], vs = faces[f][1];
    for(var v=0; v<4; v++){
      pos.push(vs[v][0]*sx, vs[v][1]*sy, vs[v][2]*sz);
      nor.push(nrm[0], nrm[1], nrm[2]);
    }
    idx.push(n, n+1, n+2, n, n+2, n+3); n += 4;
  }
  return pack(pos, nor, idx);
}
function sphereGeometry(radius, seg){
  radius = radius || 1; seg = Math.max(3, seg || 24);
  var pos=[], nor=[], idx=[];
  for(var y=0; y<=seg; y++){
    var v = y/seg, phi = v*Math.PI;
    for(var x=0; x<=seg*2; x++){
      var u = x/(seg*2), theta = u*Math.PI*2;
      var nx = Math.sin(phi)*Math.cos(theta), ny = Math.cos(phi), nz = Math.sin(phi)*Math.sin(theta);
      nor.push(nx,ny,nz); pos.push(nx*radius, ny*radius, nz*radius);
    }
  }
  var row = seg*2 + 1;
  for(var j=0; j<seg; j++){
    for(var i=0; i<seg*2; i++){
      var a = j*row+i, b = a+row;
      idx.push(a, b, a+1, a+1, b, b+1);
    }
  }
  return pack(pos, nor, idx);
}
function planeGeometry(w, h, seg){
  w = w || 1; h = h || w; seg = Math.max(1, seg || 1);
  var pos=[], nor=[], idx=[];
  for(var j=0;j<=seg;j++){
    for(var i=0;i<=seg;i++){
      pos.push((i/seg - 0.5)*w, 0, (j/seg - 0.5)*h); nor.push(0,1,0);
    }
  }
  for(var jj=0;jj<seg;jj++){
    for(var ii=0;ii<seg;ii++){
      var a = jj*(seg+1)+ii, b = a+seg+1;
      idx.push(a,b,a+1, a+1,b,b+1);
    }
  }
  return pack(pos, nor, idx);
}
function pack(pos, nor, idx){
  return {
    positions: new Float32Array(pos),
    normals: new Float32Array(nor),
    indices: (pos.length/3 > 65535) ? new Uint32Array(idx) : new Uint16Array(idx)
  };
}

/* ---- forward-lit scene renderer ---- */
var VS = [
  "attribute vec3 aPos; attribute vec3 aNor;",
  "uniform mat4 uProj, uView, uModel; uniform mat3 uNormal;",
  "varying vec3 vNor; varying vec3 vWorld;",
  "void main(){ vec4 wp = uModel * vec4(aPos,1.0); vWorld = wp.xyz;",
  " vNor = normalize(uNormal * aNor); gl_Position = uProj * uView * wp; }"
].join("\\n");
var FS = [
  "precision mediump float;",
  "varying vec3 vNor; varying vec3 vWorld;",
  "uniform vec3 uColor, uLight, uEye; uniform float uOpacity;",
  "void main(){",
  " vec3 n = normalize(vNor); vec3 l = normalize(uLight - vWorld);",
  " float diff = max(dot(n,l), 0.0);",
  " vec3 h = normalize(l + normalize(uEye - vWorld));",
  " float spec = pow(max(dot(n,h), 0.0), 32.0);",
  " vec3 c = uColor * (0.18 + 0.82*diff) + vec3(spec*0.35);",
  " gl_FragColor = vec4(c, uOpacity); }"
].join("\\n");

function scene3d(opts){
  opts = opts || {};
  var canvas = opts.canvas || fullscreenCanvas();
  var ctx = gl(canvas);
  var prog = program(ctx, VS, FS);
  var meshes = [];
  var state = {
    background: opts.background === undefined ? [0.043,0.051,0.063,1] : opts.background,
    light: opts.light || [3,4,5],
    fov: opts.fov || 0.9, near: 0.1, far: 200,
    distance: opts.distance || 6, yaw: opts.yaw || 0.6, pitch: opts.pitch === undefined ? 0.4 : opts.pitch,
    target: opts.target || [0,0,0]
  };

  ctx.enable(ctx.DEPTH_TEST);
  ctx.enable(ctx.BLEND);
  ctx.blendFunc(ctx.SRC_ALPHA, ctx.ONE_MINUS_SRC_ALPHA);

  function add(geometry, options){
    options = options || {};
    var m = {
      geometry: geometry,
      position: options.position || [0,0,0],
      rotation: options.rotation || [0,0,0],
      scale: typeof options.scale === "number" ? [options.scale,options.scale,options.scale] : (options.scale || [1,1,1]),
      color: options.color || [0.45,0.72,1.0],
      opacity: options.opacity === undefined ? 1 : options.opacity,
      wireframe: !!options.wireframe,
      visible: true,
      _p: buffer(ctx, geometry.positions),
      _n: buffer(ctx, geometry.normals),
      _i: buffer(ctx, geometry.indices, ctx.ELEMENT_ARRAY_BUFFER),
      _count: geometry.indices.length,
      _type: geometry.indices instanceof Uint32Array ? ctx.UNSIGNED_INT : ctx.UNSIGNED_SHORT
    };
    meshes.push(m);
    return m;
  }

  function eye(){
    return [
      state.target[0] + state.distance * Math.cos(state.pitch) * Math.sin(state.yaw),
      state.target[1] + state.distance * Math.sin(state.pitch),
      state.target[2] + state.distance * Math.cos(state.pitch) * Math.cos(state.yaw)
    ];
  }

  function render(){
    fit(canvas);
    ctx.viewport(0,0,canvas.width,canvas.height);
    var bg = state.background;
    ctx.clearColor(bg[0],bg[1],bg[2],bg.length>3?bg[3]:1);
    ctx.clear(ctx.COLOR_BUFFER_BIT | ctx.DEPTH_BUFFER_BIT);
    ctx.useProgram(prog);
    var e = eye();
    var proj = M.perspective(state.fov, canvas.width / Math.max(1,canvas.height), state.near, state.far);
    var view = M.lookAt(e, state.target, [0,1,0]);
    ctx.uniformMatrix4fv(prog.un("uProj"), false, proj);
    ctx.uniformMatrix4fv(prog.un("uView"), false, view);
    ctx.uniform3fv(prog.un("uLight"), new Float32Array(state.light));
    ctx.uniform3fv(prog.un("uEye"), new Float32Array(e));
    var ap = prog.at("aPos"), an = prog.at("aNor");
    for(var i=0;i<meshes.length;i++){
      var m = meshes[i];
      if(!m.visible){ continue; }
      var model = M.compose(m.position, m.rotation, m.scale);
      ctx.uniformMatrix4fv(prog.un("uModel"), false, model);
      ctx.uniformMatrix3fv(prog.un("uNormal"), false, M.normalMatrix(model));
      ctx.uniform3fv(prog.un("uColor"), new Float32Array(m.color));
      ctx.uniform1f(prog.un("uOpacity"), m.opacity);
      ctx.bindBuffer(ctx.ARRAY_BUFFER, m._p); ctx.enableVertexAttribArray(ap); ctx.vertexAttribPointer(ap,3,ctx.FLOAT,false,0,0);
      ctx.bindBuffer(ctx.ARRAY_BUFFER, m._n); ctx.enableVertexAttribArray(an); ctx.vertexAttribPointer(an,3,ctx.FLOAT,false,0,0);
      ctx.bindBuffer(ctx.ELEMENT_ARRAY_BUFFER, m._i);
      ctx.drawElements(m.wireframe ? ctx.LINES : ctx.TRIANGLES, m._count, m._type, 0);
    }
  }

  function orbitControls(){
    var dragging = false, lx = 0, ly = 0;
    canvas.addEventListener("pointerdown", function(ev){ dragging = true; lx = ev.clientX; ly = ev.clientY; });
    W.addEventListener("pointerup", function(){ dragging = false; });
    W.addEventListener("pointermove", function(ev){
      if(!dragging){ return; }
      state.yaw -= (ev.clientX - lx) * 0.01;
      state.pitch = Math.max(-1.4, Math.min(1.4, state.pitch + (ev.clientY - ly) * 0.01));
      lx = ev.clientX; ly = ev.clientY;
    });
    canvas.addEventListener("wheel", function(ev){
      ev.preventDefault();
      state.distance = Math.max(0.5, Math.min(100, state.distance * (1 + (ev.deltaY > 0 ? 0.1 : -0.1))));
    }, { passive: false });
    return state;
  }

  function run(update){
    return loop(function(f){
      if(update){ update(f); }
      render();
    });
  }

  return {
    gl: ctx, canvas: canvas, camera: state, meshes: meshes,
    add: add, render: render, run: run, orbitControls: orbitControls,
    remove: function(m){ var i = meshes.indexOf(m); if(i >= 0){ meshes.splice(i,1); } }
  };
}

/* ---- 2D convenience ---- */
function canvas2d(canvas){
  canvas = canvas || fullscreenCanvas();
  var c = canvas.getContext("2d");
  if(!c){ throw new Error("2D context unavailable"); }
  var dpr = Math.min(W.devicePixelRatio || 1, 2);
  fit(canvas); c.setTransform(dpr,0,0,dpr,0,0);
  W.addEventListener("resize", function(){
    if(fit(canvas)){ c.setTransform(dpr,0,0,dpr,0,0); }
  });
  return c;
}

var api = {
  version: ${SKETCH_RUNTIME_VERSION},
  offline: true,
  canvas: fullscreenCanvas, fit: fit, loop: loop, error: report,
  gl: gl, program: program, shader: shader, buffer: buffer, canvas2d: canvas2d,
  scene3d: scene3d, hasWebGL: function(){ return hasGL(D.createElement("canvas")); },
  box: boxGeometry, sphere: sphereGeometry, plane: planeGeometry,
  mat4: M, vec3: V,
  lerp: function(a,b,t){ return a + (b-a)*t; },
  clamp: function(v,a,b){ return Math.max(a, Math.min(b, v)); }
};
try { Object.freeze(api); Object.freeze(api.mat4); Object.freeze(api.vec3); } catch(e){}
W.Sketch = api;
W.addEventListener("error", function(ev){ report(ev.error || ev.message); });
})();`

/** The inline <script> element, ready to place in <head>. */
export const SKETCH_RUNTIME_SCRIPT = `<script>${SKETCH_RUNTIME_JS}</script>`

/** Byte length of the injected runtime — not charged to the model's budget. */
export const SKETCH_RUNTIME_BYTES = SKETCH_RUNTIME_SCRIPT.length
