'use client'

import Link from 'next/link'
import type { ComponentPropsWithRef, ComponentPropsWithoutRef } from 'react'
import styles from './button.module.css'

/**
 * The shared button. Variants and states live in button.module.css; layout is the
 * caller's job, passed through `className`.
 *
 * `type` defaults to "button", overriding the platform's "submit" default — a button
 * inside a form that submits it by accident is a bug nobody writes on purpose. Submit
 * buttons say so explicitly.
 *
 * `busy` means "this button's own action is in flight": it disables the control and
 * swaps the disabled cursor to `progress`. A button disabled for any other reason keeps
 * `not-allowed`, so a Cancel next to a busy Save never claims to be working.
 */

export type ButtonVariant = 'primary' | 'outline' | 'ghost' | 'danger'

interface StyleProps {
  variant?: ButtonVariant | undefined
  size?: 'base' | 'sm' | undefined
  className?: string | undefined
}

const classes = ({ variant = 'primary', size = 'base', className }: StyleProps): string =>
  [styles.button, styles[variant], size === 'sm' ? styles.sm : null, className]
    .filter(Boolean)
    .join(' ')

/*
 * `ComponentPropsWithRef`, not `WithoutRef`, and no forwardRef anywhere.
 *
 * React 19 passes `ref` to a function component as an ordinary prop, so it lands in `...rest`
 * and spreads onto the element with no wrapper — the forwardRef ceremony this would have
 * needed on 18 is simply gone. Only the TYPE had to widen, which is why this looked like it
 * already worked until something asked for a ref (the undo strip, which focuses itself after
 * a keyboard-initiated delete).
 */
export function Button({
  variant,
  size,
  busy = false,
  className,
  disabled = false,
  type = 'button',
  ...rest
}: StyleProps & { busy?: boolean } & ComponentPropsWithRef<'button'>) {
  return (
    <button
      {...rest}
      type={type}
      className={classes({ variant, size, className })}
      disabled={disabled || busy}
      data-busy={busy || undefined}
    />
  )
}

/** A link wearing the button's clothes — for navigations that read as actions. */
export function ButtonLink({
  variant,
  size,
  className,
  ...rest
}: StyleProps & ComponentPropsWithoutRef<typeof Link>) {
  return <Link {...rest} className={classes({ variant, size, className })} />
}
