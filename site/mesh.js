// The dot grid behind everything, as a live mesh. Dots lean away from the pointer and thread together where they
// stretch; a click on empty background bursts them into dust that drifts and settles home; scrolling slides the
// grid a little slower than the page. Scrolling only slides the canvas (on the graphics card): nothing is
// redrawn while the page scrolls, so scrolling stays smooth.
const S = 22;            // grid spacing, px
const R = 120;           // pointer reach
const BURST = 180;       // click reach
const reduced = matchMedia('(prefers-reduced-motion: reduce)');
const root = document.documentElement;

const cv = document.createElement('canvas');
cv.className = 'mesh';
cv.setAttribute('aria-hidden', 'true');
document.body.prepend(cv);
const ctx = cv.getContext('2d');

// per dot: home x, home y, x, y, vx, vy, dust (1 = just burst, 0 = settled)
let W, H, cols, rows, d, dpr, dot = '', accent = '', px = -1e4, py = -1e4;

function build() {
  dpr = Math.min(devicePixelRatio || 1, 1.5);
  W = innerWidth; H = innerHeight + S; // a row taller than the screen: the canvas slides by up to one row
  cv.width = W * dpr; cv.height = H * dpr;
  cols = Math.ceil(W / S) + 1; rows = Math.ceil(H / S) + 2;
  d = new Float32Array(cols * rows * 7);
  for (let r = 0, i = 0; r < rows; r++) for (let c = 0; c < cols; c++, i += 7) {
    d[i] = d[i + 2] = c * S + 1;
    d[i + 1] = d[i + 3] = (r - 1) * S + 1;
  }
}

function colors() {
  const cs = getComputedStyle(root);
  dot = cs.getPropertyValue('--dot').trim();
  accent = cs.getPropertyValue('--accent').trim();
}

// The loop only runs while something is happening: the pointer moving, a scroll, dust settling.
let raf = 0, busyUntil = 0, moving = false;
function wake(ms = 1400) { busyUntil = Math.max(busyUntil, performance.now() + ms); if (!raf) raf = requestAnimationFrame(frame); }
function frame(t) {
  raf = 0;
  if (root.classList.contains('viewing')) { busyUntil = 0; return; } // the photo viewer covers everything
  moving = false;
  const off = 0; // scrolling moves the canvas itself (slide() below), not the dots

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const still = reduced.matches;
  const calm = new Path2D(), dust = new Path2D(), threads = new Path2D();

  for (let i = 0; i < d.length; i += 7) {
    let tx = d[i], ty = d[i + 1] + off, near = false;
    if (!still) {
      // a slow ripple
      tx += Math.sin(d[i + 1] * 0.02 + t * 0.0004) * 1.2;
      ty += Math.cos(d[i] * 0.017 + t * 0.0003) * 1.2;
      const dx = d[i + 2] - px, dy = d[i + 3] - py, q = dx * dx + dy * dy;
      near = q < R * R * 1.4;
      if (q < R * R && q > 0.01) {
        const dist = Math.sqrt(q), f = (1 - dist / R) ** 2 * 26;
        tx += (dx / dist) * f; ty += (dy / dist) * f;
      }
    }
    const k = 0.07 * (1 - d[i + 6] * 0.96), damp = 0.76 + d[i + 6] * 0.16;
    d[i + 4] = (d[i + 4] + (tx - d[i + 2]) * k) * damp;
    d[i + 5] = (d[i + 5] + (ty - d[i + 3]) * k) * damp;
    if (still) { d[i + 2] = tx; d[i + 3] = ty; } else { d[i + 2] += d[i + 4]; d[i + 3] += d[i + 5]; }
    if (d[i + 6] > 0) { d[i + 6] = Math.max(0, d[i + 6] - 0.0055); moving = true; } // about three seconds to come home
    if (!moving && (Math.abs(d[i + 4]) > 0.02 || Math.abs(d[i + 5]) > 0.02)) moving = true;

    const x = d[i + 2], y = d[i + 3];
    if (d[i + 6] > 0.04) { const s = 0.5 + (1 - d[i + 6]) * 0.6; dust.rect(x - s / 2, y - s / 2, s, s); }
    else { calm.moveTo(x + 1, y); calm.arc(x, y, 1, 0, 6.2832); }

    // where the mesh is stretched, draw the threads to the right and lower neighbours
    const ox = x - d[i], oy = y - (d[i + 1] + off);
    if (near && ox * ox + oy * oy > 9 && d[i + 6] < 0.3) {
      const j = i + 7, b = i + cols * 7;
      if ((i / 7) % cols !== cols - 1 && j < d.length) { threads.moveTo(x, y); threads.lineTo(d[j + 2], d[j + 3]); }
      if (b < d.length) { threads.moveTo(x, y); threads.lineTo(d[b + 2], d[b + 3]); }
    }
  }
  ctx.fillStyle = dot; ctx.fill(calm);
  ctx.strokeStyle = dot; ctx.lineWidth = 0.8; ctx.stroke(threads);
  ctx.globalAlpha = 0.7; ctx.fillStyle = accent; ctx.fill(dust); ctx.globalAlpha = 1;
  if (moving || t < busyUntil) raf = requestAnimationFrame(frame);
}

function burst(x, y) {
  for (let i = 0; i < d.length; i += 7) {
    const dx = d[i + 2] - x, dy = d[i + 3] - y, dist = Math.hypot(dx, dy);
    if (dist > BURST) continue;
    const a = Math.atan2(dy, dx) + (Math.random() - 0.5) * 1.4;
    const v = (1 - dist / BURST) * (4 + Math.random() * 8);
    d[i + 4] += Math.cos(a) * v;
    d[i + 5] += Math.sin(a) * v - Math.random() * 2; // dust lifts a little as it scatters
    d[i + 6] = Math.max(d[i + 6], 0.6 + Math.random() * 0.4);
  }
}

const shiftY = () => (scrollY * 0.12) % S; // the canvas is slid up by this much (slide)
addEventListener('pointermove', e => { px = e.clientX; py = e.clientY + shiftY(); wake(); }, { passive: true });
// the grid slides at an eighth of the page's speed, repeating every row: a transform, not a redraw
let sliding = 0;
const slide = () => { sliding = 0; cv.style.transform = `translate3d(0, ${(-((scrollY * 0.12) % S)).toFixed(2)}px, 0)`; };
addEventListener('scroll', () => { sliding ||= requestAnimationFrame(slide); }, { passive: true });
addEventListener('pointerleave', () => { px = py = -1e4; });
document.addEventListener('pointerout', e => { if (!e.relatedTarget) px = py = -1e4; });
addEventListener('pointerup', e => { if (e.pointerType !== 'mouse') px = py = -1e4; });
addEventListener('pointerdown', e => {
  if (reduced.matches || e.button !== 0) return;
  if (e.target.closest('a, button, input, label, img, canvas:not(.mesh), .ribbon, .lb, .tile, .float, .row, .track, .hangs, .pullout, .timeline, .seg')) return;
  burst(e.clientX, e.clientY + shiftY());
  wake(3500);
});
addEventListener('resize', () => { build(); wake(); });
new MutationObserver(() => { colors(); wake(); }).observe(root, { attributes: true, attributeFilter: ['data-theme', 'class'] });

build();
colors();
slide();
wake(2000);
