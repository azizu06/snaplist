"use client";

import { useActionState } from "react";
import {
  submitWaitlistSignup,
  type WaitlistFormState,
} from "@/app/(marketing)/waitlist/actions";

const INITIAL_STATE: WaitlistFormState = { status: "idle" };

export function WaitlistForm() {
  const [state, action, pending] = useActionState(
    submitWaitlistSignup,
    INITIAL_STATE,
  );

  return <WaitlistFormView state={state} action={action} pending={pending} />;
}

export function WaitlistFormView({
  state,
  action,
  pending,
}: {
  state: WaitlistFormState;
  action: (formData: FormData) => void;
  pending: boolean;
}) {
  if (state.status === "success") {
    return (
      <p className="mkt-waitlist__success" role="status">
        We&apos;ll email you once when SnapList launches.
      </p>
    );
  }

  return (
    <form className="mkt-waitlist" action={action} noValidate>
      <div className="mkt-waitlist__honeypot" aria-hidden="true">
        <label htmlFor="waitlist-company">Company</label>
        <input
          id="waitlist-company"
          name="company"
          type="text"
          tabIndex={-1}
          autoComplete="off"
        />
      </div>
      <div className="mkt-waitlist__row">
        <label className="mkt-waitlist__label" htmlFor="waitlist-email">
          Email address
        </label>
        <input
          className="mkt-waitlist__input"
          id="waitlist-email"
          name="email"
          type="email"
          autoComplete="email"
          inputMode="email"
          placeholder="you@example.com"
          required
          aria-invalid={state.status === "invalid"}
          aria-describedby={
            state.status === "invalid" ? "waitlist-error" : undefined
          }
        />
        <button className="mkt-waitlist__button" type="submit" disabled={pending}>
          {pending ? "Joining..." : "Join waitlist"}
        </button>
      </div>
      {state.status === "invalid" ? (
        <p className="mkt-waitlist__error" id="waitlist-error" role="alert">
          Enter a valid email address.
        </p>
      ) : null}
    </form>
  );
}
