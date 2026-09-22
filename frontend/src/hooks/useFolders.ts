import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  listFolders,
  createFolder,
  deleteFolder,
  updateFolder,
  updateFolderType,
} from "@/api";
import type { ContentType } from "@/types/api";

export function useFolders() {
  return useQuery({
    queryKey: ["folders"],
    queryFn: listFolders,
  });
}

/** 新建分类（侧栏「+」里的「新增分类」） */
export function useCreateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { name: string; type?: ContentType }) =>
      createFolder(payload),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
    },
  });
}

export function useDeleteFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => deleteFolder(id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
      queryClient.invalidateQueries({ queryKey: ["unreadCounts"] });
    },
  });
}

export function useUpdateFolderType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; type: ContentType }) =>
      updateFolderType(payload.id, payload.type),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
    },
  });
}

export function useUpdateFolder() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (payload: { id: string; name: string }) =>
      updateFolder(payload.id, { name: payload.name }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["folders"] });
      queryClient.invalidateQueries({ queryKey: ["feeds"] });
    },
  });
}
