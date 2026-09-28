// The round being reviewed, and the actor's draft review of it, for every component on the page.
import { createContext, useContext } from "react";
import type { DraftComment, DraftCommentInput, Placement, RoundView } from "../ui/api.ts";
import { send } from "./api.ts";

export interface Review {
  view: RoundView;
  /** `/features/<slug>/rounds/<n>`, for API paths. */
  path: string;
  /** The round is open and the latest, so comments can be drafted on it. */
  canReview: boolean;
  drafts: DraftComment[];
  add(input: DraftCommentInput): Promise<void>;
  update(id: string, input: DraftCommentInput): Promise<void>;
  remove(id: string): Promise<void>;
}

export const ReviewContext = createContext<Review | null>(null);

export function useReview(): Review {
  const review = useContext(ReviewContext);
  if (!review) throw new Error("useReview outside a round");
  return review;
}

export function makeReview(view: RoundView): Review {
  const path = `/features/${encodeURIComponent(view.feature.slug)}/rounds/${view.round.n}`;
  return {
    view,
    path,
    canReview: view.latest && view.round.status === "open",
    drafts: view.draft?.comments ?? [],
    add: async (input) => {
      await send("POST", `${path}/draft/comments`, input);
    },
    update: async (id, input) => {
      await send("PUT", `${path}/draft/comments/${id}`, input);
    },
    remove: async (id) => {
      await send("DELETE", `${path}/draft/comments/${id}`);
    },
  };
}

/** The drafts placed `on` something, optionally narrowed further. */
export function draftsOn<K extends Placement["on"]>(
  drafts: DraftComment[],
  on: K,
  where: (p: Extract<Placement, { on: K }>) => boolean = () => true,
): (DraftComment & { placement: Extract<Placement, { on: K }> })[] {
  return drafts.filter(
    (d): d is DraftComment & { placement: Extract<Placement, { on: K }> } =>
      d.placement.on === on && where(d.placement as Extract<Placement, { on: K }>),
  );
}
