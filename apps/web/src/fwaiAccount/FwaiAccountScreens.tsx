import type { FwaiAccountSession, FwaiAccountUser } from "@t3tools/client-runtime/account";
import { type SubmitEvent, useState } from "react";

import { APP_DISPLAY_NAME } from "../branding";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Label } from "../components/ui/label";
import { StandalonePage, StandalonePageHeader } from "../components/ui/standalone-page";

export function FwaiAccountLoadingScreen() {
  return <div className="h-full bg-background" aria-busy="true" />;
}

function usePending() {
  const [pending, setPending] = useState(false);
  const run = (operation: () => Promise<void>) => {
    if (pending) return;
    setPending(true);
    void operation().finally(() => setPending(false));
  };
  return [pending, run] as const;
}

function ErrorAlert({ message }: { readonly message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="error">
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  );
}

export function FwaiSignInScreen({
  session,
  error,
}: {
  readonly session: FwaiAccountSession;
  readonly error: string | null;
}) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [pending, run] = usePending();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => session.signIn({ username, password }));
  };

  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Sign in to fwai"
        description="Use your fwai account."
      />
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="fwai-username">Username or email</Label>
          <Input
            id="fwai-username"
            nativeInput
            autoCapitalize="none"
            autoComplete="username"
            autoCorrect="off"
            spellCheck={false}
            disabled={pending}
            value={username}
            onChange={(event) => setUsername(event.currentTarget.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="fwai-password">Password</Label>
          <Input
            id="fwai-password"
            nativeInput
            type="password"
            autoComplete="current-password"
            disabled={pending}
            value={password}
            onChange={(event) => setPassword(event.currentTarget.value)}
          />
        </div>
        <ErrorAlert message={error} />
        <Button type="submit" disabled={pending || username.trim() === "" || password === ""}>
          {pending ? "Signing in..." : "Sign in"}
        </Button>
      </form>
    </StandalonePage>
  );
}

export function FwaiSignInCodeScreen({
  session,
  emailHint,
  codeSent,
  error,
}: {
  readonly session: FwaiAccountSession;
  readonly emailHint: string;
  readonly codeSent: boolean;
  readonly error: string | null;
}) {
  const [code, setCode] = useState("");
  const [pending, run] = usePending();

  const submit = (event: SubmitEvent<HTMLFormElement>) => {
    event.preventDefault();
    run(() => session.verifyCode(code));
  };

  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={APP_DISPLAY_NAME}
        title="Check your email"
        description={
          codeSent
            ? `Enter the code sent to ${emailHint}.`
            : `Enter the code sent to ${emailHint}. We already sent a code; it still works.`
        }
      />
      <form className="mt-6 space-y-4" onSubmit={submit}>
        <div className="space-y-2">
          <Label htmlFor="fwai-code">Code</Label>
          <Input
            id="fwai-code"
            nativeInput
            autoComplete="one-time-code"
            inputMode="numeric"
            spellCheck={false}
            disabled={pending}
            value={code}
            onChange={(event) => setCode(event.currentTarget.value)}
          />
        </div>
        <ErrorAlert message={error} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending || code.trim() === ""}>
            {pending ? "Verifying..." : "Verify"}
          </Button>
          <Button variant="outline" disabled={pending} onClick={() => session.cancelCode()}>
            Back
          </Button>
        </div>
      </form>
    </StandalonePage>
  );
}

export function FwaiSubscriptionRequiredScreen({
  session,
  user,
}: {
  readonly session: FwaiAccountSession;
  readonly user: FwaiAccountUser;
}) {
  const [checking, runCheck] = usePending();
  const [signingOut, runSignOut] = usePending();

  return (
    <StandalonePage tone="brand">
      <StandalonePageHeader
        eyebrow={user.email ?? user.username}
        title="Subscription required"
        description="This account does not have access to fwai. It needs an active plan or a licence from your organisation."
      />
      <div className="mt-6 flex flex-wrap gap-2">
        <Button
          disabled={checking || signingOut}
          onClick={() => runCheck(() => session.checkAccess({ force: true }))}
        >
          {checking ? "Checking..." : "Check again"}
        </Button>
        <Button
          variant="outline"
          disabled={signingOut}
          onClick={() => runSignOut(() => session.signOut())}
        >
          Sign out
        </Button>
      </div>
    </StandalonePage>
  );
}
