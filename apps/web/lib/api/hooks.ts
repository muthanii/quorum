"use client";

/**
 * TanStack Query hooks over the typed REST client. Live board state (chat,
 * artifacts, proposals) comes from the Yjs hooks in lib/yjs — these cover
 * only the REST-shaped data: board metadata, membership, agents, invites.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { api } from "./client";
import type {
  BoardDetailDto,
  ConnectAgentInput,
  CreateBoardInput,
  CreateInviteInput,
} from "./types";

export function useBoard(boardId: string, initialData?: BoardDetailDto) {
  return useQuery({
    queryKey: ["board", boardId],
    queryFn: () => api.getBoard(boardId),
    initialData,
    staleTime: 15_000,
  });
}

export function useBoards() {
  return useQuery({
    queryKey: ["boards"],
    queryFn: () => api.listBoards(),
  });
}

export function useCreateBoard() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateBoardInput) => api.createBoard(input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["boards"] });
    },
  });
}

export function useCreateInvite(boardId: string) {
  return useMutation({
    mutationFn: (input: CreateInviteInput) => api.createInvite(boardId, input),
  });
}

export function useConnectAgent(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: ConnectAgentInput) => api.connectAgent(boardId, input),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["board", boardId] });
    },
  });
}

export function useRemoveAgent(boardId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (agentId: string) => api.removeAgent(boardId, agentId),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["board", boardId] });
    },
  });
}
