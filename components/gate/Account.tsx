"use client";

// sign-out posts a form rather than following a <Link>: over GET, a prefetch or
// an antivirus following page links would sign the user out without a click.

import { useFormStatus } from "react-dom";

import { signOutAction } from "@/app/login/actions";
import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from "@/components/ui";
import type { Account } from "@/lib/accounts";

import styles from "./account.module.css";

export type AccountRailProps = {
  account: Account;
};

export function AccountRail({ account }: AccountRailProps) {
  const name = account.displayName?.trim() || account.email;

  return (
    <form action={signOutAction} className={styles.account}>
      <span className={styles.name} title={account.email}>
        {name}
      </span>
      <button type="submit" className={styles.signout}>
        Sign out
      </button>
    </form>
  );
}

// role="none" on the form is required: role="menu" must own its menuitem
// children, and a <form> in between drops sign-out from the announced count.
// The menu must NOT close on this click: it would unmount the form before the
// browser submits it.
export function AccountMenu({ account }: AccountRailProps) {
  const name = account.displayName?.trim() || account.email;

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel title={account.email}>{name}</DropdownMenuLabel>
      <form action={signOutAction} role="none">
        <SignOutItem />
      </form>
    </>
  );
}

// Its own component: `useFormStatus` only reads the form of an ANCESTOR.
function SignOutItem() {
  const { pending } = useFormStatus();

  return (
    <DropdownMenuItem asChild onSelect={(event) => event.preventDefault()}>
      <button
        type="button"
        className="w-full text-left"
        disabled={pending}
        onClick={(event) => event.currentTarget.form?.requestSubmit()}
      >
        {pending ? "Signing out…" : "Sign out"}
      </button>
    </DropdownMenuItem>
  );
}
