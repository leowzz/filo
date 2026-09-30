import { useInfiniteQuery } from "@tanstack/react-query";
import { useMemo } from "react";
import { api } from "./api";
import type { ListOptions, Locator } from "./types";

export function useDirectoryQuery(
  parent: Locator,
  options: ListOptions,
  enabled = true,
) {
  const query = useInfiniteQuery({
    queryKey: ["entries", parent.volume_id, parent.logical_path, options],
    queryFn: ({ pageParam }) => api.entriesPage(parent, options, pageParam),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.next_cursor ?? undefined,
    enabled: enabled && !!parent.volume_id,
    gcTime: 60_000,
    refetchOnWindowFocus: false,
  });
  const entries = useMemo(
    () => query.data?.pages.flatMap((page) => page.entries) ?? [],
    [query.data],
  );
  const latest = query.data?.pages.at(-1);
  return {
    ...query,
    entries,
    total: latest?.total ?? 0,
    totalIsExact: latest?.total_is_exact !== false,
  };
}
