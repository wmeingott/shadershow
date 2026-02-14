// Benchmark module — CPU + GPU performance testing
// Creates an offscreen ShaderRenderer to avoid disrupting the main editor

// ─── Test Shaders ───────────────────────────────────────────────────────────

const SHADERS = [
  {
    name: 'Gradient',
    complexity: 'trivial',
    source: `void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  fragColor = vec4(uv, 0.5 + 0.5 * sin(iTime), 1.0);
}`
  },
  {
    name: 'FBM Noise',
    complexity: 'light',
    source: `float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
}
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1,0)), f.x),
             mix(hash(i + vec2(0,1)), hash(i + vec2(1,1)), f.x), f.y);
}
float fbm(vec2 p) {
  float v = 0.0, a = 0.5;
  mat2 rot = mat2(0.8, 0.6, -0.6, 0.8);
  for (int i = 0; i < 8; i++) { v += a * noise(p); p = rot * p * 2.0; a *= 0.5; }
  return v;
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = fragCoord / iResolution.xy;
  float f = fbm(uv * 6.0 + iTime * 0.3);
  fragColor = vec4(vec3(f * 0.8, f * 0.6, f * 1.2), 1.0);
}`
  },
  {
    name: 'Raymarching',
    complexity: 'medium',
    source: `float sdSphere(vec3 p, float r) { return length(p) - r; }
float sdBox(vec3 p, vec3 b) { vec3 d = abs(p) - b; return min(max(d.x, max(d.y, d.z)), 0.0) + length(max(d, 0.0)); }
float scene(vec3 p) {
  float d = sdBox(p - vec3(0, -1.5, 0), vec3(5, 0.1, 5));
  d = min(d, sdSphere(p - vec3(0, 0, 0), 1.0));
  d = min(d, sdSphere(p - vec3(2.0 * sin(iTime), 0.5, 2.0 * cos(iTime)), 0.5));
  d = min(d, sdBox(p - vec3(-1.5, -0.5, 1.0), vec3(0.5)));
  return d;
}
vec3 getNormal(vec3 p) {
  vec2 e = vec2(0.001, 0.0);
  return normalize(vec3(scene(p+e.xyy)-scene(p-e.xyy), scene(p+e.yxy)-scene(p-e.yxy), scene(p+e.yyx)-scene(p-e.yyx)));
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  vec3 ro = vec3(3.0 * sin(iTime * 0.5), 2.0, 3.0 * cos(iTime * 0.5));
  vec3 ta = vec3(0.0, 0.0, 0.0);
  vec3 fwd = normalize(ta - ro), right = normalize(cross(vec3(0,1,0), fwd)), up = cross(fwd, right);
  vec3 rd = normalize(uv.x * right + uv.y * up + 1.5 * fwd);
  float t = 0.0;
  for (int i = 0; i < 100; i++) { float d = scene(ro + rd * t); if (d < 0.001 || t > 50.0) break; t += d; }
  vec3 col = vec3(0.05, 0.05, 0.1);
  if (t < 50.0) {
    vec3 p = ro + rd * t, n = getNormal(p);
    vec3 light = normalize(vec3(1, 2, 3));
    col = vec3(0.8, 0.6, 0.4) * (0.2 + 0.8 * max(dot(n, light), 0.0));
    col += pow(max(dot(reflect(-light, n), -rd), 0.0), 32.0) * 0.5;
  }
  fragColor = vec4(pow(col, vec3(0.4545)), 1.0);
}`
  },
  {
    name: 'Mandelbulb',
    complexity: 'heavy',
    source: `vec2 mandelbulb(vec3 p) {
  vec3 z = p; float dr = 1.0, r;
  for (int i = 0; i < 12; i++) {
    r = length(z); if (r > 2.0) break;
    float theta = acos(z.z / r), phi = atan(z.y, z.x);
    dr = pow(r, 7.0) * 8.0 * dr + 1.0;
    float zr = pow(r, 8.0);
    theta *= 8.0; phi *= 8.0;
    z = zr * vec3(sin(theta)*cos(phi), sin(theta)*sin(phi), cos(theta)) + p;
  }
  return vec2(0.5 * log(r) * r / dr, float(r < 2.0 ? 1 : 0));
}
vec3 getNormal(vec3 p) {
  vec2 e = vec2(0.0005, 0.0);
  return normalize(vec3(mandelbulb(p+e.xyy).x - mandelbulb(p-e.xyy).x,
                        mandelbulb(p+e.yxy).x - mandelbulb(p-e.yxy).x,
                        mandelbulb(p+e.yyx).x - mandelbulb(p-e.yyx).x));
}
void mainImage(out vec4 fragColor, in vec2 fragCoord) {
  vec2 uv = (fragCoord - 0.5 * iResolution.xy) / iResolution.y;
  float a = iTime * 0.3;
  vec3 ro = 2.5 * vec3(cos(a), 0.5, sin(a));
  vec3 ta = vec3(0), fwd = normalize(ta-ro), right = normalize(cross(vec3(0,1,0),fwd)), up = cross(fwd,right);
  vec3 rd = normalize(uv.x*right + uv.y*up + 1.5*fwd);
  float t = 0.0;
  for (int i = 0; i < 128; i++) { vec2 d = mandelbulb(ro+rd*t); if (d.x < 0.0005 || t > 10.0) break; t += d.x; }
  vec3 col = vec3(0.02, 0.02, 0.04);
  if (t < 10.0) {
    vec3 p = ro+rd*t, n = getNormal(p);
    vec3 l = normalize(vec3(1,2,3));
    col = vec3(0.6,0.4,0.8)*(0.15 + 0.85*max(dot(n,l),0.0));
    col += pow(max(dot(reflect(-l,n),-rd),0.0),16.0)*0.4;
    col *= exp(-0.1*t);
  }
  fragColor = vec4(pow(col,vec3(0.4545)),1.0);
}`
  }
];

const RESOLUTIONS = [
  { label: '360p', width: 640, height: 360 },
  { label: '720p', width: 1280, height: 720 },
  { label: '1080p', width: 1920, height: 1080 },
  { label: '4K', width: 3840, height: 2160 }
];

const GPU_FRAMES = 120;          // Frames per GPU test
const CPU_ITERATIONS = 3;        // Compile iterations for median

// ─── Scoring ────────────────────────────────────────────────────────────────

// Reference FPS targets per shader at 1080p (mid-range discrete GPU with readPixels sync)
const REFERENCE_FPS = [1500, 600, 400, 60];
// Reference compile times in ms (mid-range system)
const REFERENCE_COMPILE_MS = [2, 4, 6, 10];
const GPU_WEIGHT = 0.8;
const CPU_WEIGHT = 0.2;

function getRating(score) {
  if (score >= 180) return { text: 'Outstanding', cls: 'outstanding' };
  if (score >= 120) return { text: 'Excellent', cls: 'excellent' };
  if (score >= 80) return { text: 'Good', cls: 'good' };
  if (score >= 50) return { text: 'Fair', cls: 'fair' };
  return { text: 'Poor', cls: 'poor' };
}

function fpsClass(fps) {
  if (fps >= 60) return 'fps-good';
  if (fps >= 30) return 'fps-ok';
  return 'fps-bad';
}

function computeScore(gpuResults, cpuResults) {
  // GPU score: geometric mean of (FPS / reference) across all shader×resolution combos
  let gpuLogSum = 0, gpuCount = 0;
  for (let si = 0; si < SHADERS.length; si++) {
    for (let ri = 0; ri < RESOLUTIONS.length; ri++) {
      const fps = gpuResults[si][ri];
      const ref = REFERENCE_FPS[si] * (1080 / RESOLUTIONS[ri].height); // scale reference by resolution
      gpuLogSum += Math.log(fps / ref);
      gpuCount++;
    }
  }
  const gpuGeoMean = Math.exp(gpuLogSum / gpuCount);

  // CPU score: geometric mean of (referenceTime / actualTime) — higher is better
  let cpuLogSum = 0;
  for (let si = 0; si < SHADERS.length; si++) {
    cpuLogSum += Math.log(REFERENCE_COMPILE_MS[si] / Math.max(cpuResults[si], 0.01));
  }
  const cpuGeoMean = Math.exp(cpuLogSum / SHADERS.length);

  // Combined score on a 0-100+ scale
  const raw = (gpuGeoMean * GPU_WEIGHT + cpuGeoMean * CPU_WEIGHT) * 100;
  return Math.round(raw);
}

// ─── Benchmark Runner ───────────────────────────────────────────────────────

async function runTests(onProgress) {
  // Create benchmark canvas — must be visible (offscreen canvases get GPU-optimized away)
  const canvas = document.createElement('canvas');
  canvas.width = 640;
  canvas.height = 360;
  canvas.style.position = 'fixed';
  canvas.style.top = '0';
  canvas.style.left = '0';
  canvas.style.width = '1px';
  canvas.style.height = '1px';
  canvas.style.opacity = '0.01';
  canvas.style.pointerEvents = 'none';
  canvas.style.zIndex = '-1';
  document.body.appendChild(canvas);

  let renderer;
  try {
    renderer = new ShaderRenderer(canvas);
  } catch (e) {
    document.body.removeChild(canvas);
    throw new Error('Failed to create WebGL2 context for benchmark');
  }

  const totalSteps = SHADERS.length * (1 + RESOLUTIONS.length); // compile tests + GPU tests
  let step = 0;
  let cancelled = false;

  const cpuResults = [];   // ms per shader (median of CPU_ITERATIONS)
  const gpuResults = [];   // [shader][resolution] = FPS
  const gl = renderer.gl;

  // Pre-allocate readPixels buffer — reading 1 pixel forces a full GPU sync
  // (gl.finish() is unreliable on offscreen/small canvases; drivers may skip it)
  const syncPixel = new Uint8Array(4);
  const gpuSync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, syncPixel);

  const checkCancel = () => {
    if (cancelled) throw new Error('cancelled');
  };

  try {
    // ── CPU benchmark (compilation speed) ──
    for (let si = 0; si < SHADERS.length; si++) {
      checkCancel();
      onProgress({
        progress: step / totalSteps,
        label: `Compiling: ${SHADERS[si].name}`,
        detail: `CPU test ${si + 1}/${SHADERS.length}`
      });

      const times = [];
      for (let iter = 0; iter < CPU_ITERATIONS; iter++) {
        // Delete old program to force full recompile
        if (renderer.program) {
          renderer.gl.deleteProgram(renderer.program);
          renderer.program = null;
        }
        const t0 = performance.now();
        renderer.compile(SHADERS[si].source);
        const t1 = performance.now();
        times.push(t1 - t0);
      }
      times.sort((a, b) => a - b);
      cpuResults.push(times[Math.floor(times.length / 2)]); // median
      step++;
      // Yield to keep UI responsive
      await new Promise(r => setTimeout(r, 0));
    }

    // ── GPU benchmark (render speed) ──
    for (let si = 0; si < SHADERS.length; si++) {
      gpuResults.push([]);
      renderer.compile(SHADERS[si].source);

      for (let ri = 0; ri < RESOLUTIONS.length; ri++) {
        checkCancel();
        const res = RESOLUTIONS[ri];
        onProgress({
          progress: step / totalSteps,
          label: `Rendering: ${SHADERS[si].name} @ ${res.label}`,
          detail: `GPU test ${si * RESOLUTIONS.length + ri + 1}/${SHADERS.length * RESOLUTIONS.length}`
        });

        canvas.width = res.width;
        canvas.height = res.height;
        renderer.gl.viewport(0, 0, res.width, res.height);

        // Warm-up: 10 frames
        for (let f = 0; f < 10; f++) {
          renderer.render();
          gpuSync();
        }

        // Timed run
        const t0 = performance.now();
        for (let f = 0; f < GPU_FRAMES; f++) {
          renderer.render();
          gpuSync(); // readPixels fence — forces GPU to complete rendering
        }
        const elapsed = performance.now() - t0;
        const fps = (GPU_FRAMES / elapsed) * 1000;
        gpuResults[si].push(Math.round(fps * 10) / 10);

        step++;
        await new Promise(r => setTimeout(r, 0));
      }
    }
  } finally {
    // Cleanup — release GL resources, then remove canvas
    renderer.cleanupMouseEvents();
    if (renderer.program) {
      gl.deleteProgram(renderer.program);
      renderer.program = null;
    }
    // Delete channel textures and VAO
    for (let i = 0; i < 4; i++) {
      if (renderer.channelTextures[i]) gl.deleteTexture(renderer.channelTextures[i]);
    }
    if (renderer.vao) gl.deleteVertexArray(renderer.vao);
    // Remove canvas — avoid loseContext() which can disrupt the main renderer on macOS
    document.body.removeChild(canvas);
  }

  const score = computeScore(gpuResults, cpuResults);
  return { cpuResults, gpuResults, score, cancel: () => { cancelled = true; } };
}

// ─── Dialog UI ──────────────────────────────────────────────────────────────

function createDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'benchmark-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'benchmark-dialog';
  overlay.appendChild(dialog);

  // Header
  const header = document.createElement('div');
  header.className = 'benchmark-header';
  const title = document.createElement('h2');
  title.textContent = 'GPU / CPU Benchmark';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'benchmark-close';
  closeBtn.textContent = '\u00d7';
  header.appendChild(title);
  header.appendChild(closeBtn);
  dialog.appendChild(header);

  // Body
  const body = document.createElement('div');
  body.className = 'benchmark-body';
  dialog.appendChild(body);

  // Footer
  const footer = document.createElement('div');
  footer.className = 'benchmark-footer';
  dialog.appendChild(footer);

  return { overlay, dialog, body, footer, closeBtn };
}

function showProgressView(body, footer) {
  body.innerHTML = '';
  footer.innerHTML = '';

  const progress = document.createElement('div');
  progress.className = 'benchmark-progress';

  const label = document.createElement('div');
  label.className = 'benchmark-progress-label';
  label.textContent = 'Preparing benchmark...';

  const barOuter = document.createElement('div');
  barOuter.className = 'benchmark-progress-bar';
  const barFill = document.createElement('div');
  barFill.className = 'benchmark-progress-fill';
  barOuter.appendChild(barFill);

  const detail = document.createElement('div');
  detail.className = 'benchmark-progress-detail';

  progress.appendChild(label);
  progress.appendChild(barOuter);
  progress.appendChild(detail);
  body.appendChild(progress);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'benchmark-btn';
  cancelBtn.textContent = 'Cancel';
  footer.appendChild(cancelBtn);

  return {
    update({ progress: pct, label: lbl, detail: det }) {
      barFill.style.width = `${Math.round(pct * 100)}%`;
      label.textContent = lbl || '';
      detail.textContent = det || '';
    },
    cancelBtn
  };
}

function showResultsView(body, footer, { cpuResults, gpuResults, score }) {
  body.innerHTML = '';
  footer.innerHTML = '';

  const rating = getRating(score);

  // Score section
  const scoreSection = document.createElement('div');
  scoreSection.className = 'benchmark-score-section';

  const scoreLabel = document.createElement('div');
  scoreLabel.className = 'benchmark-score-label';
  scoreLabel.textContent = 'Overall Score';

  const scoreValue = document.createElement('div');
  scoreValue.className = 'benchmark-score-value';
  scoreValue.textContent = score;

  const ratingBadge = document.createElement('span');
  ratingBadge.className = `benchmark-rating ${rating.cls}`;
  ratingBadge.textContent = rating.text;

  scoreSection.appendChild(scoreLabel);
  scoreSection.appendChild(scoreValue);
  scoreSection.appendChild(ratingBadge);
  body.appendChild(scoreSection);

  // GPU Results Table
  const gpuSection = document.createElement('div');
  gpuSection.className = 'benchmark-table-section';
  const gpuTitle = document.createElement('h3');
  gpuTitle.textContent = 'GPU — Frames Per Second';
  gpuSection.appendChild(gpuTitle);

  const gpuTable = document.createElement('table');
  gpuTable.className = 'benchmark-table';

  // Header row
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const shaderTh = document.createElement('th');
  shaderTh.textContent = 'Shader';
  headRow.appendChild(shaderTh);
  for (const res of RESOLUTIONS) {
    const th = document.createElement('th');
    th.textContent = res.label;
    headRow.appendChild(th);
  }
  thead.appendChild(headRow);
  gpuTable.appendChild(thead);

  // Data rows
  const gpuBody = document.createElement('tbody');
  for (let si = 0; si < SHADERS.length; si++) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = SHADERS[si].name;
    tr.appendChild(nameTd);
    for (let ri = 0; ri < RESOLUTIONS.length; ri++) {
      const td = document.createElement('td');
      const fps = gpuResults[si][ri];
      td.textContent = fps.toFixed(1);
      td.className = fpsClass(fps);
      tr.appendChild(td);
    }
    gpuBody.appendChild(tr);
  }
  gpuTable.appendChild(gpuBody);
  gpuSection.appendChild(gpuTable);
  body.appendChild(gpuSection);

  // CPU Results Table
  const cpuSection = document.createElement('div');
  cpuSection.className = 'benchmark-table-section';
  const cpuTitle = document.createElement('h3');
  cpuTitle.textContent = 'CPU — Compilation Time';
  cpuSection.appendChild(cpuTitle);

  const cpuTable = document.createElement('table');
  cpuTable.className = 'benchmark-table';

  const cpuThead = document.createElement('thead');
  const cpuHeadRow = document.createElement('tr');
  const cpuShaderTh = document.createElement('th');
  cpuShaderTh.textContent = 'Shader';
  cpuHeadRow.appendChild(cpuShaderTh);
  const cpuTimeTh = document.createElement('th');
  cpuTimeTh.textContent = 'Time (ms)';
  cpuHeadRow.appendChild(cpuTimeTh);
  cpuThead.appendChild(cpuHeadRow);
  cpuTable.appendChild(cpuThead);

  const cpuBody = document.createElement('tbody');
  for (let si = 0; si < SHADERS.length; si++) {
    const tr = document.createElement('tr');
    const nameTd = document.createElement('td');
    nameTd.textContent = SHADERS[si].name;
    tr.appendChild(nameTd);
    const timeTd = document.createElement('td');
    timeTd.textContent = cpuResults[si].toFixed(1);
    tr.appendChild(timeTd);
    cpuBody.appendChild(tr);
  }
  cpuTable.appendChild(cpuBody);
  cpuSection.appendChild(cpuTable);
  body.appendChild(cpuSection);

  // Footer buttons
  const copyBtn = document.createElement('button');
  copyBtn.className = 'benchmark-btn';
  copyBtn.textContent = 'Copy Results';
  copyBtn.addEventListener('click', () => {
    const text = formatResultsText(cpuResults, gpuResults, score, rating);
    navigator.clipboard.writeText(text).then(() => {
      copyBtn.textContent = 'Copied!';
      setTimeout(() => { copyBtn.textContent = 'Copy Results'; }, 1500);
    });
  });

  const closeBtn = document.createElement('button');
  closeBtn.className = 'benchmark-btn benchmark-btn-primary';
  closeBtn.textContent = 'Close';

  footer.appendChild(copyBtn);
  footer.appendChild(closeBtn);

  return { closeBtn };
}

function formatResultsText(cpuResults, gpuResults, score, rating) {
  let text = `ShaderShow Benchmark — Score: ${score} (${rating.text})\n\n`;
  text += 'GPU FPS:\n';
  const header = ['Shader', ...RESOLUTIONS.map(r => r.label)];
  text += header.join('\t') + '\n';
  for (let si = 0; si < SHADERS.length; si++) {
    text += [SHADERS[si].name, ...gpuResults[si].map(f => f.toFixed(1))].join('\t') + '\n';
  }
  text += '\nCPU Compilation (ms):\n';
  for (let si = 0; si < SHADERS.length; si++) {
    text += `${SHADERS[si].name}\t${cpuResults[si].toFixed(1)}\n`;
  }
  return text;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export async function runBenchmark() {
  const { overlay, body, footer, closeBtn: headerClose } = createDialog();
  document.body.appendChild(overlay);

  let cancelFn = null;

  const close = () => {
    if (cancelFn) cancelFn();
    overlay.remove();
  };

  headerClose.addEventListener('click', close);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });

  const progressUI = showProgressView(body, footer);
  progressUI.cancelBtn.addEventListener('click', close);

  try {
    // Build a cancel wrapper
    let cancelled = false;
    cancelFn = () => { cancelled = true; };

    const result = await runTests((p) => {
      if (cancelled) throw new Error('cancelled');
      progressUI.update(p);
    });

    // Show results
    const { closeBtn: resultsClose } = showResultsView(body, footer, result);
    resultsClose.addEventListener('click', close);
  } catch (err) {
    if (err.message === 'cancelled') {
      close();
      return;
    }
    // Show error
    body.innerHTML = '';
    const errDiv = document.createElement('div');
    errDiv.style.color = 'var(--error-color, #ff5050)';
    errDiv.style.padding = '20px';
    errDiv.textContent = `Benchmark failed: ${err.message}`;
    body.appendChild(errDiv);

    footer.innerHTML = '';
    const closeBtn = document.createElement('button');
    closeBtn.className = 'benchmark-btn benchmark-btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', close);
    footer.appendChild(closeBtn);
  }
}
