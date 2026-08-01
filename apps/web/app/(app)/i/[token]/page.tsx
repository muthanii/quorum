import { redirect } from "next/navigation";

import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { lookupInvite } from "@/lib/server/invites";

interface InvitePageProps {
  params: Promise<{ token: string }>;
}

/**
 * /i/[token] — the one-click share link. Valid invites bounce straight to
 * the accept route handler (which owns the mutations: membership, guest
 * cookie); invalid or expired ones render an explanation here.
 */
export default async function InvitePage({ params }: InvitePageProps) {
  const { token } = await params;
  const lookup = await lookupInvite(token);

  if (lookup.status === "ok") {
    redirect(`/api/invites/${encodeURIComponent(token)}/accept`);
  }

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            {lookup.status === "expired" ? "This invite link has expired" : "Invite link not found"}
          </CardTitle>
          <CardDescription>
            {lookup.status === "expired"
              ? "Ask anyone on the board to share a fresh link — creating one takes a single click."
              : "Double-check the link, or ask the person who shared it to send a new one."}
          </CardDescription>
        </CardHeader>
        <CardContent className="text-xs text-faint">
          Quorum — shared boards for AI agents.
        </CardContent>
      </Card>
    </main>
  );
}
