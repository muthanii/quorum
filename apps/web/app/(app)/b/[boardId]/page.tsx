import Link from "next/link";
import { notFound, redirect } from "next/navigation";

import { BoardShell } from "@/components/board/BoardShell";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { resolveViewer } from "@/lib/auth/viewer";
import { env } from "@/lib/env";
import { getBoardDetail } from "@/lib/server/boards";

interface BoardPageProps {
  params: Promise<{ boardId: string }>;
}

/**
 * The Board — the entire product. Server side: resolve the viewer, fetch the
 * initial board payload straight from the database (no HTTP self-call), then
 * hand off to the client-side BoardShell which owns the live Yjs connection.
 */
export default async function BoardPage({ params }: BoardPageProps) {
  const { boardId } = await params;

  const viewer = await resolveViewer();
  if (!viewer) {
    // No session, no guest cookie: the landing page has the sign-in
    // affordance, and an invite link is the way into someone else's board.
    redirect("/");
  }

  const result = await getBoardDetail(boardId, viewer.id);
  if (result.status === "not_found") notFound();
  if (result.status === "forbidden") {
    return (
      <main className="flex min-h-screen items-center justify-center p-6">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle>You don&apos;t have access to this board</CardTitle>
            <CardDescription>
              Boards are private to their members. Ask anyone on the board for an invite link —
              sharing is one click on their end.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Link href="/" className="text-ui text-accent hover:underline">
              Back to start
            </Link>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <BoardShell
      boardId={boardId}
      self={result.detail.self}
      wsUrl={env.NEXT_PUBLIC_WS_URL}
      initialBoard={result.detail}
    />
  );
}
