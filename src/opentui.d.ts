import type { JSX } from "solid-js"

declare module "solid-js" {
  namespace JSX {
    interface IntrinsicElements {
      box: JSX.HTMLAttributes<HTMLDivElement> & {
        fg?: string
        bg?: string
        border?: boolean
        width?: number | string
        height?: number | string
      }
      text: JSX.HTMLAttributes<HTMLSpanElement> & {
        fg?: string
        bg?: string
      }
    }
  }
}
