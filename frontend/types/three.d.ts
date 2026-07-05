// Ambient shim so tsc --noEmit passes without pulling in @types/three.
// The 3D sphere is a visual-only component; the small named surface
// it uses is stubbed out here. No import/export in this file — that
// would turn it into a module and drop the ambient scope.
declare module "three" {
  const MathUtils: {
    lerp(a: number, b: number, t: number): number
    clamp(v: number, min: number, max: number): number
    [k: string]: any
  }
  type Mesh = any
  type ShaderMaterial = any
  export { MathUtils, Mesh, ShaderMaterial }
  const _all: any
  export default _all
}
