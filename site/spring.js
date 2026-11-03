// Interruptible springs in Apple's terms: damping ratio (1 = no overshoot) and response (seconds).
// A spring always continues from its current value and velocity, so any motion can be grabbed
// and redirected mid-flight.
export const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

const active = new Set();
let raf = 0, last = 0;

export class Spring {
  constructor(value, { damping = 1, response = 0.5, precision = 0.05, onUpdate } = {}) {
    Object.assign(this, { value, target: value, velocity: 0, damping, response, precision, onUpdate });
  }
  to(target, { velocity, damping, response, onRest } = {}) {
    this.target = target;
    if (velocity !== undefined) this.velocity = velocity;
    if (damping !== undefined) this.damping = damping;
    if (response !== undefined) this.response = response;
    this.onRest = onRest;
    if (reducedMotion.matches) { this.set(target); onRest?.(); return this; }
    active.add(this);
    if (!raf) { last = performance.now(); raf = requestAnimationFrame(frame); }
    return this;
  }
  set(value) { this.value = this.target = value; this.velocity = 0; this.stop(); this.onUpdate?.(value); }
  stop() { active.delete(this); this.onRest = null; }
  get moving() { return active.has(this); }
}

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000) || 1 / 60;
  last = now;
  const steps = Math.ceil(dt * 240), h = dt / steps;
  for (const s of active) {
    const k = (2 * Math.PI / s.response) ** 2, c = 4 * Math.PI * s.damping / s.response;
    for (let i = 0; i < steps; i++) {
      s.velocity += (-k * (s.value - s.target) - c * s.velocity) * h;
      s.value += s.velocity * h;
    }
    if (Math.abs(s.value - s.target) < s.precision && Math.abs(s.velocity) < s.precision * 10) {
      s.value = s.target; s.velocity = 0;
      const done = s.onRest;
      active.delete(s); s.onRest = null;
      s.onUpdate?.(s.value); done?.();
    } else s.onUpdate?.(s.value);
  }
  raf = active.size ? requestAnimationFrame(frame) : 0;
}

// Where a flick would come to rest (Apple's scroll-deceleration projection).
export const project = (velocity, rate = 0.998) => (velocity / 1000) * rate / (1 - rate);

// Soft resistance past an edge.
export const rubberband = (over, dim, c = 0.55) => (over * dim * c) / (dim + c * Math.abs(over));
