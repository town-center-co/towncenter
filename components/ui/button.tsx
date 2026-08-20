import { cva, type VariantProps } from "class-variance-authority";
import { Loader2 } from "lucide-react";
import { Slot } from "radix-ui";
import type { ComponentProps } from "react";

import { cn } from "@/lib/utils";

// The art direction is the `.button` block in globals.css; variants point at it.
const buttonVariants = cva("button", {
  variants: {
    variant: {
      primary: "button--primary",
      secondary: "button--secondary",
      quiet: "button--quiet",
      danger: "button--danger",
    },
    size: {
      default: "",
      compact: "button--compact",
    },
  },
  defaultVariants: {
    variant: "secondary",
    size: "default",
  },
});

export type ButtonProps = ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean;
    fullWidth?: boolean;
    /** Swaps the leading edge for a spinner and disables the button. A `useActionState`
     *  pending flag passes straight through — the click is a form submit that leaves
     *  the page for a beat, and a disabled label alone reads as a dead button. */
    loading?: boolean;
  };

function Button({
  className,
  variant,
  size,
  fullWidth = false,
  asChild = false,
  // Without an explicit `type`, a button in a form defaults to `submit`.
  type = "button",
  loading = false,
  disabled,
  children,
  ...props
}: ButtonProps) {
  const Comp = asChild ? Slot.Root : "button";
  // Slot.Root accepts exactly one child, so asChild cannot render a spinner sibling.
  const spinner = loading && !asChild ? <Loader2 className="button__spinner" aria-hidden="true" /> : null;

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      data-loading={loading || undefined}
      type={asChild ? undefined : type}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn(
        buttonVariants({ variant, size }),
        fullWidth && "button--full",
        className,
      )}
      {...props}
    >
      {asChild ? children : (
        <>
          {spinner}
          {children}
        </>
      )}
    </Comp>
  );
}

export { Button, buttonVariants };
