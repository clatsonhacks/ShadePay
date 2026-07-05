// @react-three/fiber augments JSX with lowercase THREE element proxies
// (mesh, ambientLight, icosahedronGeometry, shaderMaterial, …). Without
// @types/three the augmentation is missing. Widen the JSX intrinsic set
// with a catch-all so the sentient-sphere renders fine under tsc --noEmit.
// React 19 uses `React.JSX.IntrinsicElements` under the modern jsx-transform,
// but keep the legacy global.JSX augmentation too for older React types
// still referenced by @react-three/fiber.
import "react"

declare module "react" {
  namespace JSX {
    interface IntrinsicElements {
      [elementName: string]: any
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      [elementName: string]: any
    }
  }
}

export {}
