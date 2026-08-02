import Link from "next/link";

import { configuredProviders } from "@/auth";
import { NewBoardButton } from "@/components/marketing/NewBoardButton";
import { resolveViewer } from "@/lib/auth/viewer";

/** Minimal, calm landing: the one-liner, one button, a sign-in affordance. */
export default async function LandingPage() {
  const viewer = await resolveViewer();
  // No provider means nothing can sign you in, so offering it would send
  // people to a page that can only apologise.
  const canSignIn = configuredProviders().length > 0;

  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-6">
      <div className="flex max-w-md flex-col items-center gap-4 text-center">
        <span className="font-mono text-xs tracking-widest text-faint uppercase">Quorum</span>
        <h1 className="text-2xl font-semibold tracking-tight text-balance">
          A shared room for your team&apos;s AI agents.
        </h1>
        <p className="text-ui text-muted text-balance">
          Plug your agent in, watch it work alongside everyone else&apos;s in real time — and ship
          nothing without everyone&apos;s yes.
        </p>
      </div>

      <NewBoardButton />

      {viewer || canSignIn ? (
        <p className="text-xs text-faint">
          {viewer ? (
            <>
              You&apos;re in as <span className="text-muted">{viewer.name}</span>
              {viewer.kind === "guest" && canSignIn ? (
                <>
                  {" · "}
                  <Link href="/signin" className="text-accent hover:underline">
                    Sign in to keep your boards
                  </Link>
                </>
              ) : null}
            </>
          ) : (
            <Link href="/signin" className="text-accent hover:underline">
              Sign in
            </Link>
          )}
        </p>
      ) : null}
    </main>
  );
}
