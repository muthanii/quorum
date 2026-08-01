"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api/client";
import { useCreateBoard } from "@/lib/api/hooks";

/**
 * Zero setup: one click creates a board (minting a guest identity if the
 * visitor is anonymous) and lands them in it.
 */
export function NewBoardButton() {
  const router = useRouter();
  const createBoard = useCreateBoard();
  const [error, setError] = useState<string | null>(null);

  return (
    <div className="flex flex-col items-center gap-2">
      <Button
        size="lg"
        disabled={createBoard.isPending}
        onClick={() => {
          setError(null);
          createBoard.mutate(
            {},
            {
              onSuccess: (response) => router.push(`/b/${response.board.id}`),
              onError: (err) =>
                setError(
                  err instanceof ApiError ? err.message : "Could not create a board. Try again.",
                ),
            },
          );
        }}
      >
        {createBoard.isPending ? "Creating…" : "New board"}
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-danger">
          {error} <span className="text-muted">Click the button to retry.</span>
        </p>
      ) : null}
    </div>
  );
}
