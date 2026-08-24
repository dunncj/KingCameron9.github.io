// A "curve" is nothing more than a function from normalized progress
// (0..1) to normalized progress (0..1). Every shape below, and every way
// of combining them, is built from plain functions and closures — there's
// no class anywhere in this file. A curve is a value you pass around and
// call, not an object you instantiate.
export type Curve = (x: number) => number;

export interface CurveParamSpec {
  min: number;
  max: number;
  default: number;
  step?: number;
}

export interface CurveDescriptor {
  readonly name: string;
  readonly label: string;
  // Declared purely for GUI generation (see flightCurves.ts) — a curve
  // that ignores `params` just omits this.
  readonly params?: Readonly<Record<string, CurveParamSpec>>;
  readonly create: (params?: Readonly<Record<string, number>>) => Curve;
}

// --- registrar ------------------------------------------------------------
// A closure-based registry, not a class: calling this returns a small
// bundle of functions that all close over one private Map. The app only
// ever needs one (see `curveRegistrar` below), but nothing here assumes
// that — a test could make its own throwaway registrar the same way.
export function createCurveRegistrar() {
  const descriptors = new Map<string, CurveDescriptor>();

  function register(descriptor: CurveDescriptor): void {
    descriptors.set(descriptor.name, descriptor);
  }

  function get(name: string): CurveDescriptor | undefined {
    return descriptors.get(name);
  }

  function create(name: string, params?: Readonly<Record<string, number>>): Curve {
    const descriptor = descriptors.get(name);
    if (!descriptor) throw new Error(`curveRegistrar: no curve registered as "${name}"`);
    return descriptor.create(params);
  }

  function list(): CurveDescriptor[] {
    return [...descriptors.values()];
  }

  return { register, get, create, list };
}

export const curveRegistrar = createCurveRegistrar();

// --- composition ------------------------------------------------------------
// Chains curves left to right: pipeCurves(a, b)(x) === b(a(x)).
export function pipeCurves(...curves: Curve[]): Curve {
  return (x) => curves.reduce((acc, curve) => curve(acc), x);
}

// "Speed traveled through the curve" — a pacing knob independent of the
// curve's own shape, composed in front of it rather than baked into a new
// named curve per rate: remaps normalized time by a power curve (x**rate)
// before handing it to `shape`. rate === 1 leaves the shape untouched;
// rate > 1 lingers near x=0 longer before rushing into the shape's own
// motion; rate < 1 rushes the start and lingers into the shape's tail.
// Because this composes with *any* registered shape, "which curve" and
// "how fast you travel through it" stay two independent choices instead of
// one combined curve you'd otherwise need a name for.
export function withSpeed(shape: Curve, rate: number): Curve {
  if (rate === 1) return shape;
  return (x) => shape(x ** rate);
}

// --- built-in shapes ------------------------------------------------------
const linear: Curve = (x) => x;
const cubicIn: Curve = (x) => x * x * x;
const cubicOut: Curve = (x) => 1 - (1 - x) ** 3;
const cubicInOut: Curve = (x) => (x < 0.5 ? 4 * x ** 3 : 1 - (-2 * x + 2) ** 3 / 2);
const quartIn: Curve = (x) => x ** 4;
const quartOut: Curve = (x) => 1 - (1 - x) ** 4;

// A genuine 1/x (hyperbolic) speed curve, not a polynomial ease: the
// instantaneous speed of easeHyperbolicOut is literally k/(1+k*x) — a real
// reciprocal decay from a sharp burst at x=0 down to a steady coast, sharper
// and more sudden than a cubic/quart's smoother S-shaped falloff the higher
// `k` (sharpness) goes. easeHyperbolicIn is its exact time-mirror. Paired
// together (one "in", one "out") their speeds cross at exactly x=0.5.
function hyperbolicOut(x: number, k: number): number {
  return Math.log(1 + k * x) / Math.log(1 + k);
}
function hyperbolicIn(x: number, k: number): number {
  return 1 - hyperbolicOut(1 - x, k);
}

curveRegistrar.register({ name: 'linear', label: 'Linear', create: () => linear });
curveRegistrar.register({ name: 'cubic-in', label: 'Cubic (in)', create: () => cubicIn });
curveRegistrar.register({ name: 'cubic-out', label: 'Cubic (out)', create: () => cubicOut });
curveRegistrar.register({ name: 'cubic-in-out', label: 'Cubic (in-out)', create: () => cubicInOut });
curveRegistrar.register({ name: 'quart-in', label: 'Quart (in)', create: () => quartIn });
curveRegistrar.register({ name: 'quart-out', label: 'Quart (out)', create: () => quartOut });
curveRegistrar.register({
  name: 'hyperbolic-out',
  label: 'Hyperbolic (out)',
  params: { sharpness: { min: 1, max: 60, default: 24, step: 0.5 } },
  create: (params) => {
    const k = params?.sharpness ?? 24;
    return (x) => hyperbolicOut(x, k);
  },
});
curveRegistrar.register({
  name: 'hyperbolic-in',
  label: 'Hyperbolic (in)',
  params: { sharpness: { min: 1, max: 60, default: 24, step: 0.5 } },
  create: (params) => {
    const k = params?.sharpness ?? 24;
    return (x) => hyperbolicIn(x, k);
  },
});
