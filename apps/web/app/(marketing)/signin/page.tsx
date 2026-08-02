import Link from "next/link";

import { configuredProviders, signIn } from "@/auth";
import { NewBoardButton } from "@/components/marketing/NewBoardButton";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { safeCallbackUrl } from "@/lib/auth/safe-callback";

interface SignInPageProps {
  searchParams: Promise<{ callbackUrl?: string; error?: string }>;
}

/**
 * /signin — Auth.js `pages.signIn`, replacing the built-in page.
 *
 * Two states, because a bare setup ships with no OAuth keys (zero-setup
 * principle) and the built-in page renders an empty card in that case:
 * providers configured → a button each; none → say so plainly and offer the
 * guest path, which already works and is what most people want anyway.
 */
export default async function SignInPage({ searchParams }: SignInPageProps) {
  const { callbackUrl, error } = await searchParams;
  const providers = configuredProviders();
  const redirectTo = safeCallbackUrl(callbackUrl);

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {providers.length > 0 ? "Sign in to Quorum" : "Sign-in isn’t set up"}
          </CardTitle>
          <CardDescription>
            {providers.length > 0
              ? "Signing in keeps your boards across devices. You can also just start a board as a guest."
              : "This deployment has no sign-in provider configured, so there’s nothing to sign in with yet. Guest boards work fine without one."}
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          {error ? (
            <p role="alert" className="text-danger w-full text-xs">
              That sign-in attempt didn’t go through. Try again, or start a board as a guest.
            </p>
          ) : null}

          {providers.map((provider) => (
            <form
              key={provider.id}
              className="w-full"
              action={async () => {
                "use server";
                await signIn(provider.id, { redirectTo });
              }}
            >
              <Button type="submit" className="w-full">
                Continue with {provider.name}
              </Button>
            </form>
          ))}

          {providers.length > 0 ? (
            <Link href="/" className="text-accent text-xs hover:underline">
              Back to Quorum
            </Link>
          ) : (
            <>
              <NewBoardButton />
              <Link href="/" className="text-accent text-xs hover:underline">
                Back to Quorum
              </Link>
            </>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
