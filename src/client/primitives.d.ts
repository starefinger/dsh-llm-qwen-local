/**
 * Ambient type declarations for `@deepseek-ai/dsh-client-ui-primitives`.
 *
 * The package is a web-shell *platform module*: it is seeded into the runtime
 * module table at boot and resolved from there, so the bundle's `require`
 * never touches `node_modules`. It is therefore absent from this project's
 * `node_modules` too (it is not a declared dependency), so TypeScript has no
 * on-disk declarations to read. This ambient module gives the client half the
 * prop shapes the shared controls expose — the exact set this page uses — so
 * the page can adopt the host's own themed controls instead of restyling
 * native `<input>` / `<button>` / `<label>` by hand (which is what made the
 * form look foreign against the rest of the app).
 *
 * The file must stay a global *script* (no top-level import): with a
 * top-level import, the `declare module` below would be parsed as an
 * augmentation of an unresolvable module and silently dropped. The React
 * types are imported inside the module block instead.
 *
 * Only included by the client tsconfig (`src/client/**`); the node build
 * excludes `src/client`, so it never leaks into the Node half.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type * as React from 'react'

  /** The shared controls render their own focus ring, padding, and radius from
   * the host theme; callers pass the standard input attributes through. */
  export interface InputProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'className'> {
    /** Extra class appended to the input wrapper. */
    className?: string
    /** Optional leading icon node. */
    icon?: React.ReactNode
  }
  /** Themed single-line input (text / number / password all pass through). */
  export function Input(props: InputProps): JSX.Element

  export interface ButtonProps extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'className'> {
    className?: string
    /** Visual treatment: `ghost` (default, subtle) or `primary` (accented). */
    variant?: 'ghost' | 'primary' | 'outline'
    /** `md` (default, 36px) or `sm` (28px) for controls beside fields. */
    size?: 'md' | 'sm'
    icon?: React.ReactNode
  }
  /** Themed push button (`type="button"` by default, per the shared control). */
  export function Button(props: ButtonProps): JSX.Element

  export interface CheckboxProps {
    checked: boolean
    onChange: (checked: boolean) => void
    label: React.ReactNode
    disabled?: boolean
    title?: string
    className?: string
  }
  /** Themed checkbox with an inline text label. */
  export function Checkbox(props: CheckboxProps): JSX.Element

  /** One selectable tab. */
  export interface SegmentedOption<T extends string> {
    value: T
    label: React.ReactNode
    title?: string
    disabled?: boolean
  }
  export interface SegmentedControlProps<T extends string> {
    id: string
    value: T
    options: SegmentedOption<T>[]
    onChange: (value: T) => void
    label?: string
    disabled?: boolean
    className?: string
  }
  /** Themed radio-button group with a sliding selection indicator (a11y: tablist). */
  export function SegmentedControl<T extends string>(props: SegmentedControlProps<T>): JSX.Element
}
