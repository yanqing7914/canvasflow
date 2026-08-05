/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** AMap Web (JS API) key. Absent in the default keyless build. See env.example. */
  readonly VITE_AMAP_JS_KEY?: string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
