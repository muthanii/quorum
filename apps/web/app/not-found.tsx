import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NewBoardButton } from "@/components/marketing/NewBoardButton";

/**
 * App-wide 404. A mistyped or deleted board id is the common way to land
 * here, and Next's built-in page is an unbranded dead end with no way back —
 * so this mirrors the invite-link error state and always offers the one
 * action that recovers: start a board.
 */
export default function NotFound() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>This board doesn’t exist</CardTitle>
          <CardDescription>
            The link may be mistyped, or the board may have been deleted. Ask whoever shared it for
            a fresh link — or start your own.
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col items-center gap-3">
          <NewBoardButton />
          <p className="text-xs text-faint">Quorum — shared boards for AI agents.</p>
        </CardContent>
      </Card>
    </main>
  );
}
